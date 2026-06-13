// BS-WS-001 clean fixture: socket.io connection handler with auth middleware
// The io.use() auth middleware is registered before io.on('connection').

// Simulated socket.io-style interface for the fixture
interface Socket {
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  emit: (event: string, data: unknown) => void;
}

interface Server {
  on: (event: string, handler: (socket: Socket) => void) => void;
  use: (middleware: (...args: unknown[]) => void) => void;
}

function createSocketServer(): Server {
  return {
    on: (_event, _handler) => {},
    use: (_middleware) => {},
  };
}

function verifyToken(_socket: unknown, next: () => void): void {
  // verify JWT token from handshake
  next();
}

const io = createSocketServer();

// Safe: auth middleware registered via io.use() before connection handler
io.use(verifyToken);

io.on('connection', (socket: Socket) => {
  socket.on('message', (data) => {
    socket.emit('response', data);
  });
});

export { io };
