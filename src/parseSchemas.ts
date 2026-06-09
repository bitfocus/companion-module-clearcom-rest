import { ControlDef, SettingValueType, KeyAssignCapabilities, KeySlotField } from './types.js'
import { LoadedSchemas } from './loadSchemas.js'
import { SKIP_PORT_SETTINGS, SKIP_KEYSET_SETTINGS, SKIP_LIVE_STATUS } from './commands.js'
import { makeLogger } from './logger.js'

const log = makeLogger('parseSchemas', () => undefined)

const DEFINITION_TO_DEVICE: Record<string, string> = {
	HMS4XSettings: 'HMS-4X',
	HRM4XSettings: 'HRM-4X',
	HKB2XSettings: 'HKB-2X',
	HBP2XSettings: 'HBP-2X',
	FSIIBPSettings: 'FSII-BP',
	EDGEBPSettings: 'E-BP',
	NEPSettings: 'NEP',
	VSeriesPanel12KeySettings: 'V-Series-12',
	VSeriesPanel24KeySettings: 'V-Series-24',
	VSeriesPanel32KeySettings: 'V-Series-32',
	VSeriesPanel12DKeySettings: 'V-Series-12D',
}

export const DEVICE_TYPE_TO_KEYSET_TYPE: Record<string, string[]> = {
	'HMS-4X': ['HMS-4X'],
	'HRM-4X': ['HRM-4X'],
	'HKB-2X': ['HKB-2X'],
	'HBP-2X': ['HBP-2X'],
	'FSII-BP': ['FSII-BP'],
	'E-BP': ['E-BP'],
	NEP: ['NEP'],
	'V-Series-12': ['V12'],
	'V-Series-12D': ['V12D'],
	'V-Series-24': ['V24', 'V24D'],
	'V-Series-32': ['V32', 'V32D'],
}

const V_SERIES_KEY_COUNT: Record<string, number> = {
	'V-Series-12': 12,
	'V-Series-12D': 12,
	'V-Series-24': 24,
	'V-Series-32': 32,
}

const V_SERIES_VARIANTS = new Set([
	'VSeriesPanel12KeySettings',
	'VSeriesPanel24KeySettings',
	'VSeriesPanel32KeySettings',
	'VSeriesPanel12DKeySettings',
])
const V_SERIES_BASE = 'VSeriesPanelSettingsBase'

const GAIN_OVERRIDE_2W: SettingValueType = { kind: 'number-enum', values: [-3, -2, -1, 0, 1, 2, 3] }
const GAIN_KEYS = new Set(['inputGain', 'outputGain'])

function toLabel(key: string): string {
	return key
		.replace(/([A-Z])/g, ' $1')
		.replace(/^./, (c) => c.toUpperCase())
		.trim()
}

function parseProperty(prop: Record<string, unknown>): SettingValueType | null {
	const type = prop.type as string
	const enumVals = prop.enum as unknown[] | undefined

	if (type === 'boolean') return { kind: 'boolean' }

	if (type === 'string') {
		if (enumVals) return { kind: 'string-enum', values: enumVals as string[] }
		return { kind: 'string' }
	}

	if (type === 'integer' || type === 'number') {
		if (enumVals) {
			const nums = (enumVals as (number | null)[]).filter((v): v is number => v !== null).sort((a, b) => a - b)
			const enumNames = (prop['x-enumNames'] as string[] | undefined) ?? (prop['enumNames'] as string[] | undefined)
			let labels: string[] | undefined
			if (enumNames) {
				const paired = (enumVals as (number | null)[])
					.map((v, i) => ({ v, label: enumNames[i] }))
					.filter((x): x is { v: number; label: string } => x.v !== null)
					.sort((a, b) => a.v - b.v)
				labels = paired.map((x) => x.label)
			}
			return { kind: 'number-enum', values: nums, labels }
		}
		if ('minimum' in prop && 'maximum' in prop) {
			const step = (prop.multipleOf as number | undefined) ?? 1
			return {
				kind: 'integer',
				min: prop.minimum as number,
				max: prop.maximum as number,
				step,
			}
		}
		return null
	}

	return null
}

function buildPortControlDefs(refSchemas: Record<string, Record<string, unknown>>): ControlDef[] {
	const getSchema = refSchemas['response_schemas/port_get.schema.json']
	const putSchema = refSchemas['request_schemas/ports_put_update.schema.json']
	if (!getSchema || !putSchema) return []

	const getProps =
		((getSchema.properties as Record<string, Record<string, unknown>>)?.port_settings?.properties as Record<
			string,
			Record<string, unknown>
		>) ?? {}
	const putProps = (putSchema.properties as Record<string, Record<string, unknown>>) ?? {}

	const defs: ControlDef[] = []

	for (const [key, prop] of Object.entries(getProps)) {
		if (SKIP_PORT_SETTINGS.has(key)) continue
		if (!(key in putProps)) continue

		const valueType = parseProperty(prop)
		if (!valueType) continue

		const isGain = GAIN_KEYS.has(key)

		defs.push({
			id: `port.${key}`,
			label: toLabel(key),
			scope: 'port',
			deviceTypes: [],
			read: {
				store: 'ports',
				field: `port_settings.${key}`,
				fetchFn: 'fetchPorts',
			},
			write: {
				method: 'PUT',
				pathTemplate: '{res}',
				bodyKey: key,
				fetchFn: 'fetchPorts',
			},
			valueType,
			supportsIncDec: valueType.kind === 'integer' || valueType.kind === 'number-enum',
			perTypeOverride: isGain ? { '2W': GAIN_OVERRIDE_2W } : undefined,
		})
	}

	const labelInPut = putProps['label']
	if (labelInPut) {
		defs.push({
			id: 'port.label',
			label: 'Label',
			scope: 'port',
			deviceTypes: [],
			read: {
				store: 'ports',
				field: 'port_label',
				fetchFn: 'fetchPorts',
			},
			write: {
				method: 'PUT',
				pathTemplate: '{res}',
				bodyKey: 'label',
				fetchFn: 'fetchPorts',
			},
			valueType: { kind: 'string' },
			supportsIncDec: false,
		})
	}

	return defs
}

function buildEndpointControlDefs(refSchemas: Record<string, Record<string, unknown>>): ControlDef[] {
	const getSchema = refSchemas['response_schemas/endpoint_get.schema.json']
	const putSchema = refSchemas['request_schemas/endpoints_put_update.schema.json']
	if (!getSchema) return []

	const defs: ControlDef[] = []

	const hasPutLabel = putSchema && 'label' in ((putSchema.properties as Record<string, unknown>) ?? {})

	defs.push({
		id: 'endpoint.label',
		label: 'Label',
		scope: 'endpoint',
		deviceTypes: [],
		read: {
			store: 'endpoints',
			field: 'label',
			fetchFn: 'fetchEndpoints',
		},
		write: hasPutLabel
			? {
					method: 'PUT',
					pathTemplate: '{res}',
					bodyKey: 'label',
					fetchFn: 'fetchEndpoints',
				}
			: null,
		valueType: { kind: 'string' },
		supportsIncDec: false,
	})

	const liveStatusProps =
		((getSchema.properties as Record<string, Record<string, unknown>>)?.liveStatus?.properties as Record<
			string,
			Record<string, unknown>
		>) ?? {}

	for (const [key, prop] of Object.entries(liveStatusProps)) {
		if (SKIP_LIVE_STATUS.has(key)) continue

		if (prop.type === 'object' && prop.properties) {
			const subProps = prop.properties as Record<string, Record<string, unknown>>
			for (const subKey of Object.keys(subProps)) {
				defs.push({
					id: `endpoint.liveStatus.${key}.${subKey}`,
					label: toLabel(`${key} ${subKey}`),
					scope: 'endpoint',
					deviceTypes: [],
					read: {
						store: 'endpointStatus',
						field: `${key}.${subKey}`,
						fetchFn: 'fetchEndpoints',
					},
					write: null,
					valueType: { kind: 'string' },
					supportsIncDec: false,
				})
			}
			continue
		}

		const valueType = parseProperty(prop) ?? { kind: 'string' as const }
		const finalValueType: SettingValueType = key === 'status' ? { kind: 'boolean' } : valueType

		defs.push({
			id: `endpoint.liveStatus.${key}`,
			label: key === 'status' ? 'Online' : toLabel(key),
			scope: 'endpoint',
			deviceTypes: [],
			read: {
				store: 'endpointStatus',
				field: key,
				fetchFn: 'fetchEndpoints',
			},
			write: null,
			valueType: finalValueType,
			supportsIncDec: false,
		})
	}

	return defs
}

function buildRoleControlDefs(refSchemas: Record<string, Record<string, unknown>>): ControlDef[] {
	const getSchema = refSchemas['response_schemas/roleset_get.schema.json']
	const putSchema = refSchemas['request_schemas/rolesets_put_update.schema.json']
	if (!getSchema) return []

	const defs: ControlDef[] = []

	defs.push({
		id: 'role.description',
		label: 'Description',
		scope: 'role',
		deviceTypes: [],
		read: {
			store: 'keysets',
			field: 'description',
			fetchFn: 'fetchKeysets',
		},
		write: {
			method: 'PUT',
			pathTemplate: '{res}',
			bodyKey: 'description',
			keysetBodyLevel: 'top',
			fetchFn: 'fetchKeysets',
		},
		valueType: { kind: 'string' },
		supportsIncDec: false,
	})

	defs.push({
		id: 'role.label',
		label: 'Label',
		scope: 'role',
		deviceTypes: [],
		read: {
			store: 'rolesets',
			field: 'label',
			fetchFn: 'fetchRolesets',
		},
		write: putSchema
			? {
					method: 'PUT',
					pathTemplate: '{res}',
					bodyKey: 'label',
					fetchFn: 'fetchRolesets',
				}
			: null,
		valueType: { kind: 'string' },
		supportsIncDec: false,
	})

	return defs
}

function deriveDefinitionToDevice(
	putSchema: Record<string, unknown>,
	definitions: Record<string, Record<string, unknown>>,
): Record<string, string> {
	const derived: Record<string, string> = {}
	const container = (putSchema['additionalProperties'] ?? putSchema) as Record<string, unknown>
	for (const entry of (container['oneOf'] as Array<Record<string, unknown>>) ?? []) {
		const ref = entry['$ref'] as string | undefined
		if (!ref) continue
		const roleDef = definitions[ref.split('/').pop() ?? '']
		if (!roleDef) continue
		const props = roleDef['properties'] as Record<string, Record<string, unknown>> | undefined
		const typeString = (props?.['type']?.['enum'] as unknown[] | undefined)?.find(
			(t): t is string => typeof t === 'string',
		)
		const settingsDefName = (props?.['settings']?.['$ref'] as string | undefined)?.split('/').pop()
		if (typeString && settingsDefName) derived[settingsDefName] = typeString
	}
	return { ...derived, ...DEFINITION_TO_DEVICE }
}

function buildKeysetControlDefs(refSchemas: Record<string, Record<string, unknown>>): ControlDef[] {
	const getSchema = refSchemas['response_schemas/keysets_get_2.schema.json']
	const putSchema = refSchemas['request_schemas/keysets_put_update_2.schema.json']
	if (!getSchema || !putSchema) return []

	const getDefs = (getSchema.definitions ?? putSchema.definitions) as Record<string, Record<string, unknown>>
	const putDefs = (putSchema.definitions ?? {}) as Record<string, Record<string, unknown>>

	const effectiveDefToDevice = deriveDefinitionToDevice(putSchema, putDefs)
	const defs: ControlDef[] = []

	for (const [defName, deviceType] of Object.entries(effectiveDefToDevice)) {
		const sourceDefName = V_SERIES_VARIANTS.has(defName) ? V_SERIES_BASE : defName

		const putDef = putDefs[sourceDefName] ?? putDefs[defName]
		const getDef = getDefs[sourceDefName] ?? putDef
		if (!putDef) continue

		const getProps = (getDef.properties as Record<string, Record<string, unknown>>) ?? {}
		const putProps = (putDef.properties as Record<string, Record<string, unknown>>) ?? {}

		for (const [key, prop] of Object.entries(putProps)) {
			if (SKIP_KEYSET_SETTINGS.has(key)) continue
			if (!(key in getProps)) continue

			const valueType = parseProperty(prop)
			if (!valueType) continue

			defs.push({
				id: `keyset.${deviceType}.${key}`,
				label: toLabel(key.replace(/^port(?=[A-Z])/, '')),
				scope: 'role',
				deviceTypes: [deviceType],
				read: {
					store: 'keysets',
					field: `settings.${key}`,
					fetchFn: 'fetchKeysets',
				},
				write: {
					method: 'PUT',
					pathTemplate: '{res}',
					bodyKey: key,
					fetchFn: 'fetchKeysets',
				},
				valueType,
				supportsIncDec: valueType.kind === 'integer' || valueType.kind === 'number-enum',
			})
		}
	}

	return defs
}

export function buildControlDefs(loadedSchemas: LoadedSchemas): ControlDef[] {
	const refs = loadedSchemas.refSchemas as unknown as Record<string, Record<string, unknown>>

	return [
		...buildPortControlDefs(refs),
		...buildEndpointControlDefs(refs),
		...buildRoleControlDefs(refs),
		...buildKeysetControlDefs(refs),
	]
}

export type { ControlDef }

const SKIP_KEY_SLOT_FIELDS = new Set(['keysetIndex', 'entities', 'isCallKey', 'isReplyKey', 'isPgm', 'colorIndex'])

export function parseKeyAssignCapabilities(loadedSchemas: LoadedSchemas): Record<string, KeyAssignCapabilities> {
	const putSchema = loadedSchemas.refSchemas['request_schemas/keysets_put_update_2.schema.json'] as unknown as Record<
		string,
		unknown
	>
	if (!putSchema) return {}

	const definitions = putSchema['definitions'] as Record<string, Record<string, unknown>> | undefined
	if (!definitions) return {}

	const bulkPutAccepted = new Set<string>()
	const container = (putSchema['additionalProperties'] ?? putSchema) as Record<string, unknown>
	for (const entry of (container['oneOf'] as Array<Record<string, unknown>>) ?? []) {
		const ref = entry['$ref'] as string | undefined
		if (!ref) continue
		const defName = ref.split('/').pop() ?? ''
		const roleDef = definitions[defName]
		if (!roleDef) continue
		const typeEnum = (roleDef['properties'] as Record<string, Record<string, unknown>> | undefined)?.['type']?.[
			'enum'
		] as unknown[] | undefined
		for (const t of typeEnum ?? []) if (typeof t === 'string') bulkPutAccepted.add(t)
	}
	const bulkPutKnown = bulkPutAccepted.size > 0

	const effectiveDefToDevice = deriveDefinitionToDevice(putSchema, definitions)

	const getKeysetsItemProps = (defName: string): Record<string, Record<string, unknown>> => {
		const source = V_SERIES_VARIANTS.has(defName) ? V_SERIES_BASE : defName
		const def = definitions[source]
		if (!def) return {}
		const keysets = (def['properties'] as Record<string, Record<string, unknown>> | undefined)?.['keysets']
		return ((keysets?.['items'] as Record<string, Record<string, unknown>> | undefined)?.['properties'] ??
			{}) as Record<string, Record<string, unknown>>
	}

	const result: Record<string, KeyAssignCapabilities> = {}

	for (const [defName, deviceType] of Object.entries(effectiveDefToDevice)) {
		const def = definitions[defName]
		if (!def) continue

		const keysetsDef = V_SERIES_VARIANTS.has(defName) ? definitions[V_SERIES_BASE] : def
		const keysets = (keysetsDef?.['properties'] as Record<string, Record<string, unknown>> | undefined)?.['keysets']
		const schemaKeyCount = keysets?.['maxItems'] as number | undefined
		const keyCount = V_SERIES_KEY_COUNT[deviceType] ?? schemaKeyCount
		if (keyCount === undefined) {
			log.warn(`parseKeyAssignCapabilities: no keyCount for ${deviceType} — skipping`)
			continue
		}

		const itemProps = getKeysetsItemProps(defName)
		const supportsCallKey = 'isCallKey' in itemProps

		const slotFields: KeySlotField[] = []
		for (const [key, prop] of Object.entries(itemProps)) {
			if (SKIP_KEY_SLOT_FIELDS.has(key)) continue
			let valueType = parseProperty(prop)
			if (!valueType) continue
			if (key === 'interlockGroup' && valueType.kind === 'integer' && valueType.min === 0 && valueType.max === 1) {
				valueType = { kind: 'number-enum', values: [0, 1], labels: ['None', 'Group 1'] }
			}
			const firstValue =
				valueType.kind === 'string-enum'
					? valueType.values[0]
					: valueType.kind === 'number-enum'
						? valueType.values[0]
						: valueType.kind === 'boolean'
							? false
							: valueType.kind === 'integer'
								? valueType.min
								: ''
			slotFields.push({
				key,
				label: toLabel(key),
				valueType,
				default: firstValue,
			})
		}

		if (slotFields.length === 0) continue
		const keysetTypes = DEVICE_TYPE_TO_KEYSET_TYPE[deviceType] ?? [deviceType]
		const supportsBulkPut = !bulkPutKnown || keysetTypes.some((kt) => bulkPutAccepted.has(kt))
		result[deviceType] = { keyCount, slotFields, supportsCallKey, supportsBulkPut }
	}

	return result
}

export function parseGpiCapabilities(loadedSchemas: LoadedSchemas): boolean {
	return 'request_schemas/gpi_events_post_add.schema.json' in (loadedSchemas.refSchemas as Record<string, unknown>)
}
