export type FeedbackStore = ReadDef['store'] | 'nulling' | 'gpi'

export type SettingValueType =
	| { kind: 'integer'; min: number; max: number; step: number }
	| { kind: 'number-enum'; values: number[]; labels?: string[] }
	| { kind: 'string-enum'; values: string[] }
	| { kind: 'boolean' }
	| { kind: 'string' }
	| { kind: 'string-array' }

export type ControlScope = 'port' | 'endpoint' | 'role'

export type ReadDef = {
	store: 'ports' | 'endpoints' | 'endpointStatus' | 'rolesets' | 'connections' | 'keysets'
	field: string
	fetchFn: 'fetchPorts' | 'fetchEndpoints' | 'fetchRolesets' | 'fetchConnections' | 'fetchKeysets'
}

export type WriteDef = {
	method: 'PUT' | 'POST'
	pathTemplate: string
	bodyKey: string
	keysetBodyLevel?: 'settings' | 'top'
	fetchFn: 'fetchPorts' | 'fetchEndpoints' | 'fetchRolesets' | 'fetchConnections' | 'fetchKeysets'
}

export type ControlDef = {
	id: string
	label: string
	description?: string
	scope: ControlScope
	deviceTypes: string[]
	read: ReadDef | null
	write: WriteDef | null
	valueType: SettingValueType
	supportsIncDec: boolean
	perTypeOverride?: Record<string, SettingValueType>
}

export type DeviceRecord = Record<string, unknown>

export type DeviceInfo = {
	device_id: number
	device_label: string
	deviceType_name: string
	device_versionSW?: string
	versionSW?: string
	versionHW?: string
	uptime?: number
	device_liveStatus?: {
		fanStatus?: { Name: string; SpeedPercentageOfMax: number }[]
		temperatureSensors?: { sensorName: string; temperatureCentigrade: number }[]
		[key: string]: unknown
	}
}

export type EndpointUpdatedEvent = {
	endpointId: number
	path: string
	value: unknown
}

export type SchemaValueType = SettingValueType

export type KeySlotField = {
	key: string
	label: string
	valueType: SettingValueType
	default: unknown
}

export type KeyAssignCapabilities = {
	keyCount: number
	slotFields: KeySlotField[]
}
