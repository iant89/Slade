import { createShellServer } from './shell-server'

const token = process.env.SLADE_SHELL_TOKEN ?? ''
const root = process.env.SLADE_SHELL_ROOT
if (!root) throw new Error('Set SLADE_SHELL_ROOT to an explicit checkout directory. Commands have full host-user permissions.')
const { server, stop } = await createShellServer({ token, root })
const port = Number(process.env.SLADE_SHELL_PORT ?? 8788)
server.listen(port, '127.0.0.1', () => console.log(`Slade shell backend listening on loopback port ${port}. Automatic execution has full host-user permissions.`))
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
