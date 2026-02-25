export type KeyState = Record<string, { keysetIndex: number; currentState: string; volume: number }>

export type BeltpackLiveStatus = {
	status: string
	internalStatus: string
	batteryLevel: number
	batteryType: string
	batteryStatus: number
	rssi: number
	linkQuality: number
	frameErrorRate: number
	antennaIndex: number
	antennaSlot: number
	longevity: { hours: number; minutes: number }
	gid: string
	session: string
	sessionRes: string
	association: { dpId: number; dpType: string; dpGid: string }
	keyState: KeyState
	device_id: number
}

export type BeltpackEndpoint = {
	id: number
	gid: string
	label: string
	type: string
	device_id: number
	liveStatus: BeltpackLiveStatus | Record<string, never>
}

export type RolesetSession = {
	gid: string
	res: string
	live: Record<string, unknown>
	data: {
		id: number
		type: string
		label?: string
		auth?: unknown[]
		profile?: Record<string, unknown>
		settings?: Record<string, unknown>
	}
}

export type Roleset = {
	id: number
	name: string
	label?: string
	sessions?: Record<string, RolesetSession>
}

export type EndpointUpdatedLiveStatus = {
	endpointId: number
	path: 'liveStatus'
	value: BeltpackLiveStatus | Record<string, never>
}

export type EndpointUpdatedKeyState = {
	endpointId: number
	path: 'liveStatus.keyState'
	value: KeyState
}

export type EndpointUpdatedEvent = EndpointUpdatedLiveStatus | EndpointUpdatedKeyState

export type Keyset = {
	id: number
	type: string
	settings: {
		portInputGain?: number
		[key: string]: unknown
	}
}
