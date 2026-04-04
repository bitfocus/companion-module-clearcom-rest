import { ControlDef, SettingValueType, KeyAssignCapabilities } from './types.js'
import { LoadedSchemas } from './loadSchemas.js'
import { SKIP_PORT_SETTINGS, SKIP_KEYSET_SETTINGS, SKIP_LIVE_STATUS } from './commands.js'

// ─── Device type mapping ──────────────────────────────────────────────────────
// Maps schema definition names to the device type strings the Arcadia uses.
// These are stable identifiers from the schema — if new device types are added
// in firmware, new entries appear in the definitions and map here.

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

// Maps deviceType → the 'type' string used in /api/2/keysets responses.
// Derived from observed device data — the schema does not expose these strings.
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

// Key counts per V-Series variant — the schema base definition reports maxItems=32
// for all variants, so we override per variant based on hardware key counts.
const V_SERIES_KEY_COUNT: Record<string, number> = {
	'V-Series-12': 12,
	'V-Series-12D': 12,
	'V-Series-24': 24,
	'V-Series-32': 32,
}

// V-Series variants inherit capabilities from the base definition
const V_SERIES_VARIANTS = new Set([
	'VSeriesPanel12KeySettings',
	'VSeriesPanel24KeySettings',
	'VSeriesPanel32KeySettings',
	'VSeriesPanel12DKeySettings',
])
const V_SERIES_BASE = 'VSeriesPanelSettingsBase'

// ─── Fields to skip ───────────────────────────────────────────────────────────
// Complex objects/arrays that can't be represented as simple value controls,
// or internal structural fields not useful as Companion actions/feedbacks.

// ─── Per-type gain overrides ──────────────────────────────────────────────────
// The schema reports a single gain range for all port types, but the device
// enforces different ranges per port type. These corrections are sourced from
// Clear-Com hardware documentation, not the schema.

const GAIN_OVERRIDE_2W: SettingValueType = { kind: 'number-enum', values: [-3, -2, -1, 0, 1, 2, 3] }
const GAIN_KEYS = new Set(['inputGain', 'outputGain'])

// ─── Utility ──────────────────────────────────────────────────────────────────

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
			// Align labels to the filtered+sorted nums if present
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
			// JSON Schema integers without multipleOf have an implicit step of 1
			const step = (prop.multipleOf as number | undefined) ?? 1
			return {
				kind: 'integer',
				min: prop.minimum as number,
				max: prop.maximum as number,
				step,
			}
		}
		// No constraints — not representable as a control, skip
		return null
	}

	return null
}

// ─── Port ControlDefs ─────────────────────────────────────────────────────────
// Cross-references port_get.schema.json (port_settings.*) with
// ports_put_update.schema.json (top-level keys) to find read+write fields.

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
		// Must be writable too (present in PUT schema)
		if (!(key in putProps)) continue

		const valueType = parseProperty(prop)
		if (!valueType) continue

		const isGain = GAIN_KEYS.has(key)

		defs.push({
			id: `port.${key}`,
			label: toLabel(key),
			scope: 'port',
			deviceTypes: [], // applies to all port types
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

	// Port label — readable from top-level port_label, writable via label key in PUT
	const labelInPut = putProps['label']
	if (labelInPut) {
		defs.push({
			id: 'port.label',
			label: 'Port Label',
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

// ─── Endpoint ControlDefs ─────────────────────────────────────────────────────
// Label: readable + writable.
// LiveStatus fields: read-only feedbacks only.

function buildEndpointControlDefs(refSchemas: Record<string, Record<string, unknown>>): ControlDef[] {
	const getSchema = refSchemas['response_schemas/endpoint_get.schema.json']
	const putSchema = refSchemas['request_schemas/endpoints_put_update.schema.json']
	if (!getSchema) return []

	const defs: ControlDef[] = []

	// Label — read from endpoint, write via PUT
	const hasPutLabel = putSchema && 'label' in ((putSchema.properties as Record<string, unknown>) ?? {})

	defs.push({
		id: 'endpoint.label',
		label: 'Endpoint Label',
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

	// LiveStatus fields — read-only
	const liveStatusProps =
		((getSchema.properties as Record<string, Record<string, unknown>>)?.liveStatus?.properties as Record<
			string,
			Record<string, unknown>
		>) ?? {}

	for (const [key, prop] of Object.entries(liveStatusProps)) {
		if (SKIP_LIVE_STATUS.has(key)) continue

		// Handle nested objects (e.g. longevity.hours, longevity.minutes)
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
					valueType: { kind: 'string' }, // subfield type not specified in schema
					supportsIncDec: false,
				})
			}
			continue
		}

		// For read-only liveStatus fields, fall back to string display if no
		// constraints are defined — unconstrained integers are still displayable.
		const valueType = parseProperty(prop) ?? { kind: 'string' as const }

		// status field becomes a boolean 'online' check
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

// ─── Role ControlDefs ─────────────────────────────────────────────────────────
// Name/label from roleset_get + rosesets_put_update.
// Keyset settings per device type from keysets_get_2 + keysets_put_update_2.

function buildRoleControlDefs(refSchemas: Record<string, Record<string, unknown>>): ControlDef[] {
	const getSchema = refSchemas['response_schemas/roleset_get.schema.json']
	const putSchema = refSchemas['request_schemas/rolesets_put_update.schema.json']
	if (!getSchema) return []

	const defs: ControlDef[] = []

	// Role description — top-level field on the keyset (not nested in settings)
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

	// Role label — 'label' is the display name, 'name' is the unique system identifier
	defs.push({
		id: 'role.label',
		label: 'Role Label',
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

// ─── Keyset (role settings) ControlDefs ───────────────────────────────────────
// Per-device-type settings stored in the keyset, accessed via /api/2/keysets.
// Cross-references keysets_get_2 (readable) with keysets_put_update_2 (writable).

function buildKeysetControlDefs(refSchemas: Record<string, Record<string, unknown>>): ControlDef[] {
	const getSchema = refSchemas['response_schemas/keysets_get_2.schema.json']
	const putSchema = refSchemas['request_schemas/keysets_put_update_2.schema.json']
	if (!getSchema || !putSchema) return []

	const getDefs = (getSchema.definitions ?? putSchema.definitions) as Record<string, Record<string, unknown>>
	const putDefs = (putSchema.definitions ?? {}) as Record<string, Record<string, unknown>>

	const defs: ControlDef[] = []

	for (const [defName, deviceType] of Object.entries(DEFINITION_TO_DEVICE)) {
		// V-Series variants inherit settings from base
		const sourceDefName = V_SERIES_VARIANTS.has(defName) ? V_SERIES_BASE : defName

		// PUT schema is authoritative for value types — it defines accepted values.
		// GET schema is only consulted to confirm a field is readable.
		const putDef = putDefs[sourceDefName] ?? putDefs[defName]
		const getDef = getDefs[sourceDefName] ?? putDef
		if (!putDef) continue

		const getProps = (getDef.properties as Record<string, Record<string, unknown>>) ?? {}
		const putProps = (putDef.properties as Record<string, Record<string, unknown>>) ?? {}

		for (const [key, prop] of Object.entries(putProps)) {
			if (SKIP_KEYSET_SETTINGS.has(key)) continue
			// Must also be readable (present in GET schema)
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

// ─── Public API ───────────────────────────────────────────────────────────────

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

// ─── Key assign capabilities ──────────────────────────────────────────────────
// Parses keysets_put_update_2.schema.json to extract per-device-type key counts,
// activation states, and talk button modes. Used by actions.ts to build
// the assign key action options.

export function parseKeyAssignCapabilities(loadedSchemas: LoadedSchemas): Record<string, KeyAssignCapabilities> {
	const putSchema = loadedSchemas.refSchemas['request_schemas/keysets_put_update_2.schema.json'] as unknown as Record<
		string,
		unknown
	>
	if (!putSchema) return {}

	const definitions = putSchema['definitions'] as Record<string, Record<string, unknown>> | undefined
	if (!definitions) return {}

	const getKeysetsItemProps = (defName: string): Record<string, unknown> => {
		const source = V_SERIES_VARIANTS.has(defName) ? V_SERIES_BASE : defName
		const def = definitions[source]
		if (!def) return {}
		const keysets = (def['properties'] as Record<string, Record<string, unknown>> | undefined)?.['keysets']
		return (keysets?.['items'] as Record<string, Record<string, unknown>> | undefined)?.['properties'] ?? {}
	}

	const result: Record<string, KeyAssignCapabilities> = {}

	for (const [defName, deviceType] of Object.entries(DEFINITION_TO_DEVICE)) {
		const def = definitions[defName]
		if (!def) continue

		// V-Series variants inherit keyCount from the base definition, but the base
		// reports maxItems=32 for all variants. Use the per-variant override if available.
		const keysetsDef = V_SERIES_VARIANTS.has(defName) ? definitions[V_SERIES_BASE] : def
		const keysets = (keysetsDef?.['properties'] as Record<string, Record<string, unknown>> | undefined)?.['keysets']
		const schemaKeyCount = keysets?.['maxItems'] as number | undefined
		const keyCount = V_SERIES_KEY_COUNT[deviceType] ?? schemaKeyCount
		if (keyCount === undefined) {
			console.warn(`parseKeyAssignCapabilities: no keyCount for ${deviceType} — skipping`)
			continue
		}
		const itemProps = getKeysetsItemProps(defName)
		const activationStates =
			((itemProps['activationState'] as Record<string, unknown> | undefined)?.['enum'] as string[] | null) ?? null
		const talkBtnModes = (itemProps['talkBtnMode'] as Record<string, unknown> | undefined)?.['enum'] as
			| string[]
			| undefined
		if (!talkBtnModes) continue

		result[deviceType] = { keyCount, activationStates, talkBtnModes }
	}

	return result
}
