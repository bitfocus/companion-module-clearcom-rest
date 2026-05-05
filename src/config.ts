import { Regex, type SomeCompanionConfigField, type JsonObject } from '@companion-module/base'

// ─── Endpoint type choices ────────────────────────────────────────────────────

export const ENDPOINT_TYPES = [
	'HMS-4X',
	'HRM-4X',
	'HKB-2X',
	'HBP-2X',
	'FSII-BP',
	'E-BP',
	'NEP',
	'V-Series-12',
	'V-Series-24',
	'V-Series-32',
] as const

// ─── Schema cache ─────────────────────────────────────────────────────────────

export interface CachedSchema extends JsonObject {
	version: string
	data: JsonObject
}

// ─── Per-device schema path blacklists ───────────────────────────────────────

const SHARED_BLACKLIST = [
	'/1/certificate',
	'/1/devices/{deviceId}/upload',
	'/1/devices/{deviceId}/upgrade',
	'/1/devices/{deviceId}/firmware',
	'/1/devices/{deviceId}/license',
	'/1/devices/{deviceId}/snapshot',
	'/1/devices/{deviceId}/restore',
	'/1/devices/{deviceId}/reboot',
	'/1/devices/{deviceId}/resettodefault',
	'/1/devices/{deviceId}/otastate',
	'/1/devices/{deviceId}/setnetmode',
	'/1/devices/{deviceId}/setupnetwork',
	'/1/devices/{deviceId}/networkEvent',
	'/1/externalDevices',
	'/1/ivpusers',
	'/1/datadefinition',
]

export const SCHEMA_BLACKLIST: Record<string, string[]> = {
	'NEP-ARCADIA': [
		...SHARED_BLACKLIST,
		'/1/devices/{deviceId}/interfaces/{interfaceId}/ports/{portId}/calls',
		'/1/devices/interfaces/ports/calls',
		'/1/devices/{deviceId}/interfaces/ports/calls',
	],
	_default: SHARED_BLACKLIST,
}

export function getBlacklistForDevice(deviceType: string): string[] {
	return SCHEMA_BLACKLIST[deviceType] ?? SCHEMA_BLACKLIST['_default']
}

export function filterSchema(schema: Record<string, unknown>, deviceType: string): Record<string, unknown> {
	const blacklist = getBlacklistForDevice(deviceType)
	const paths = schema['paths'] as Record<string, unknown> | undefined
	if (!paths) return schema

	const filteredPaths: Record<string, unknown> = {}
	for (const [path, def] of Object.entries(paths)) {
		if (!blacklist.some((bl) => path.startsWith(bl))) {
			filteredPaths[path] = def
		}
	}

	return { ...schema, paths: filteredPaths }
}

// ─── Config & secrets types ───────────────────────────────────────────────────

export interface ModuleConfig extends JsonObject {
	host: string
	endpointTypes: string[]
	logLevel: 'debug' | 'info' | 'none' | null
	schemaCache: Record<string, CachedSchema> | null
	refreshSchema: boolean | null
}

export interface ModuleSecrets extends JsonObject {
	password: string
}

// ─── Field definitions ────────────────────────────────────────────────────────

export function GetConfigFields(): SomeCompanionConfigField[] {
	return [
		{
			type: 'textinput',
			id: 'host',
			label: 'Arcadia IP',
			width: 4,
			regex: Regex.IP,
		},
		{
			type: 'secret-text',
			id: 'password',
			label: 'Admin Password',
			width: 8,
		},
		{
			type: 'multidropdown',
			id: 'endpointTypes',
			label: 'Endpoint Types',
			width: 12,
			default: [],
			choices: ENDPOINT_TYPES.map((t) => ({ id: t, label: t })),
		},
		{
			type: 'dropdown',
			id: 'logLevel',
			label: 'Log Level',
			width: 12,
			default: 'info',
			choices: [
				{ id: 'debug', label: 'Debug' },
				{ id: 'info', label: 'Info' },
				{ id: 'none', label: 'None' },
			],
		},
		{
			type: 'static-text',
			id: 'refreshSchemaLabel',
			label: 'Schema',
			value:
				'Check this box and click Save to force a fresh schema download from the device on next connect. The box will automatically uncheck after the refresh is triggered.',
			width: 12,
		},
		{
			type: 'checkbox',
			id: 'refreshSchema',
			label: 'Refresh schema on next connect',
			width: 12,
			default: false,
		},
	]
}
