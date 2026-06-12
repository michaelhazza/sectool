import { describe, expect, it } from 'vitest';
import { TOOL_NAME, toolBanner } from './index.js';

describe('toolBanner', () => {
  it('includes the tool name', () => {
    expect(toolBanner()).toContain(TOOL_NAME);
  });
});
