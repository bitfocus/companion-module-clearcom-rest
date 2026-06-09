// socket.io-client is intentionally pinned to v2.5.0.
// The Clear-Com Arcadia uses the socket.io v2 / Engine.IO v3 protocol on its
// server. socket.io-client v4 negotiates EIO v4 by default and cannot connect
// to a v2 server without a non-trivial downgrade shim. This type declaration
// file exists because @types/socket.io-client targets v4 and is incompatible
// with the v2 package shape.

declare module 'socket.io-client' {
	interface SocketOptions {
		transports?: string[]
		path?: string
		extraHeaders?: Record<string, string>
	}

	type EventCallback = (...args: any[]) => void

	interface Socket {
		connected: boolean
		on(event: string, callback: EventCallback): this
		disconnect(): this
	}

	function io(url: string, opts?: SocketOptions): Socket

	export { Socket }
	export default io
}
