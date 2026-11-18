import { once } from 'node:events'
import { createServer } from 'node:net'

export async function claimInstanceOperation(binding, operation) {
  // The kernel releases this address when the process exits, including abrupt exits.
  const name = `open-science-integration-${operation}-${binding}`
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : `\0${name}`
  const server = createServer(socket => socket.destroy())
  try {
    server.listen(address)
    await once(server, 'listening')
    return () => server.close()
  } catch (error) {
    if (error.code === 'EADDRINUSE') return undefined
    throw error
  }
}
