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
