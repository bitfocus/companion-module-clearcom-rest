// ─── Feedback store type ─────────────────────────────────────────────────────
// All valid store names for feedbackTriggers, including 'nulling' which is
// a special non-store trigger used only by the nulling poll loop.
export type FeedbackStore = ReadDef['store'] | 'nulling'

// ─── ControlDef ───────────────────────────────────────────────────────────────
// The universal structure produced by parseschema.ts.
// One ControlDef per controllable or observable field.
// actions.ts, feedbacks.ts, and arcadia.ts all walk this structure.
// All field paths use dot-notation, resolved at runtime via getField().

export type SettingValueType =
	| { kind: 'integer'; min: number; max: number; step: number }
	| { kind: 'number-enum'; values: number[] }
	| { kind: 'string-enum'; values: string[] }
	| { kind: 'boolean' }
	| { kind: 'string' }
	| { kind: 'string-array' } // read-only, e.g. active calls list

export type ControlScope = 'port' | 'endpoint' | 'role'

export type ReadDef = {
	// Which Map on the instance holds this data
	store: 'ports' | 'endpoints' | 'endpointStatus' | 'rolesets' | 'connections' | 'keysets'
	// Dot-notation path into the stored Record<string, unknown>
	// e.g. 'port_settings.inputGain', 'liveStatus.batteryLevel'
	field: string
	// Which network.ts fetch function refreshes this store
	fetchFn: 'fetchPorts' | 'fetchEndpoints' | 'fetchRolesets' | 'fetchConnections' | 'fetchKeysets'
}

export type WriteDef = {
	method: 'PUT' | 'POST'
	// {res} is substituted with the record's own res field at runtime
	// e.g. '{res}' → '/api/1/devices/1/interfaces/256/ports/65536'
	pathTemplate: string
	// Key used in the request body: { [bodyKey]: value }
	bodyKey: string
	// For keyset writes: 'settings' (default, nested under settings.*) or 'top' (top-level field like description)
	keysetBodyLevel?: 'settings' | 'top'
	// Fetch to call after a successful write to refresh state
	fetchFn: 'fetchPorts' | 'fetchEndpoints' | 'fetchRolesets' | 'fetchConnections' | 'fetchKeysets'
}

export type ControlDef = {
	id: string // e.g. 'port.inputGain', 'role.name'
	label: string // shown in Companion UI
	scope: ControlScope
	deviceTypes: string[] // empty = all types within scope
	read: ReadDef | null // null = write-only
	write: WriteDef | null // null = read-only
	valueType: SettingValueType
	supportsIncDec: boolean
	perTypeOverride?: Record<string, SettingValueType> // e.g. '2W' gets different gain range
}

// ─── Device data stores ───────────────────────────────────────────────────────
// All device data is stored as generic records.
// Field access is always via getField(record, 'dot.path') from utils.ts.
// No hardcoded property assumptions — the schema is the source of truth.

export type DeviceRecord = Record<string, unknown>

// ─── Device info ─────────────────────────────────────────────────────────────
// Minimal typed structure just for module variables — populated from
// GET /api/1/devices/{id}, fields match device_get.schema.json

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

// ─── Socket event shapes ──────────────────────────────────────────────────────
// These are typed because we must handle specific socket message structures.
// If the device changes these shapes, the socket handler in network.ts
// needs updating regardless — so typing them is appropriate.

export type EndpointUpdatedEvent = {
	endpointId: number
	path: string // e.g. 'liveStatus', 'liveStatus.keyState'
	value: unknown
}

// ─── Schema parsed structures ─────────────────────────────────────────────────
// Intermediate results from parseschema.ts before ControlDef is built.
// These map directly to what the schema files contain.

export type SchemaValueType = SettingValueType // same shape, different origin

export type KeyAssignCapabilities = {
	keyCount: number
	activationStates: string[] | null
	talkBtnModes: string[]
}
