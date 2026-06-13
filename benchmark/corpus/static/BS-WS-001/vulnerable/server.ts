// BS-WS-001 vulnerable fixture: socket.io connection handler without auth middleware
// The io.on('connection') handler is registered without any io.use() auth middleware.

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

const io = createSocketServer();

// Vulnerable: no io.use() auth middleware registered before the connection handler
io.on('connection', (socket: Socket) => {
  socket.on('message', (data) => {
    socket.emit('response', data);
  });
});

export { io };
