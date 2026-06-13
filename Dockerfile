# syntax=docker/dockerfile:1

# Stage 1: build the Node/TS tool
FROM node:20-bookworm-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src/ src/
RUN npm run build

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2: runtime image with pinned scanner binaries + built dist/
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime

# Pinned scanner versions (record also in KNOWLEDGE.md):
#   semgrep     1.78.0
#   gitleaks    8.18.4
#   osv-scanner 1.8.1
#   OWASP ZAP   2.17.0
#   nuclei      3.2.9
ENV SEMGREP_VERSION=1.78.0 \
    GITLEAKS_VERSION=8.18.4 \
    OSV_SCANNER_VERSION=1.8.1 \
    ZAP_VERSION=2.17.0 \
    NUCLEI_VERSION=3.2.9

# System deps for scanners
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    wget \
    python3 \
    python3-pip \
    openjdk-17-jre-headless \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# ── Semgrep (Python-based; install via pip at pinned version) ────────────────
RUN pip3 install --no-cache-dir --break-system-packages "semgrep==${SEMGREP_VERSION}"

# ── gitleaks (Go binary, released as a single static binary) ────────────────
RUN ARCH="$(dpkg --print-architecture)"; \
    case "$ARCH" in \
      amd64) GL_ARCH="x64" ;; \
      arm64) GL_ARCH="arm64" ;; \
      *) echo "Unsupported arch: $ARCH" && exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_${GL_ARCH}.tar.gz" \
      -o /tmp/gitleaks.tar.gz && \
    tar -xzf /tmp/gitleaks.tar.gz -C /usr/local/bin gitleaks && \
    chmod +x /usr/local/bin/gitleaks && \
    rm /tmp/gitleaks.tar.gz

# ── osv-scanner (Go binary) ──────────────────────────────────────────────────
RUN ARCH="$(dpkg --print-architecture)"; \
    case "$ARCH" in \
      amd64) OSV_ARCH="amd64" ;; \
      arm64) OSV_ARCH="arm64" ;; \
      *) echo "Unsupported arch: $ARCH" && exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/google/osv-scanner/releases/download/v${OSV_SCANNER_VERSION}/osv-scanner_linux_${OSV_ARCH}" \
      -o /usr/local/bin/osv-scanner && \
    chmod +x /usr/local/bin/osv-scanner

# ── OWASP ZAP (Java; distributed as a packaged release) ─────────────────────
RUN curl -fsSL "https://github.com/zaproxy/zaproxy/releases/download/v${ZAP_VERSION}/ZAP_${ZAP_VERSION}_Linux.tar.gz" \
      -o /tmp/zap.tar.gz && \
    tar -xzf /tmp/zap.tar.gz -C /opt && \
    mv "/opt/ZAP_${ZAP_VERSION}" /opt/zap && \
    ln -s /opt/zap/zap.sh /usr/local/bin/zap.sh && \
    rm /tmp/zap.tar.gz

# ── Nuclei (Go binary) ───────────────────────────────────────────────────────
RUN ARCH="$(dpkg --print-architecture)"; \
    case "$ARCH" in \
      amd64) NUCLEI_ARCH="amd64" ;; \
      arm64) NUCLEI_ARCH="arm64" ;; \
      *) echo "Unsupported arch: $ARCH" && exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/projectdiscovery/nuclei/releases/download/v${NUCLEI_VERSION}/nuclei_${NUCLEI_VERSION}_linux_${NUCLEI_ARCH}.zip" \
      -o /tmp/nuclei.zip && \
    unzip -q /tmp/nuclei.zip nuclei -d /usr/local/bin/ && \
    chmod +x /usr/local/bin/nuclei && \
    rm /tmp/nuclei.zip

# ── Tool runtime ─────────────────────────────────────────────────────────────
WORKDIR /app

# Copy built artifacts from the builder stage
COPY --from=builder /app/dist/ dist/
COPY --from=builder /app/node_modules/ node_modules/
COPY package.json ./

# Copy checked-in config, rules, and benchmark allowlist
COPY config/ config/
COPY rules/ rules/

# Exec-wrapper entrypoint: lets `docker run img npm run benchmark` pass through
# directly while `docker run img run --repo foo` prepends `node dist/cli.js`.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Non-root user for security. Shell is /bin/sh (not /bin/false) so that the
# entrypoint wrapper and npm/node commands execute inside the container.
RUN useradd --system --no-create-home --shell /bin/sh audit && \
    chown -R audit:audit /app
USER audit

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["--help"]
