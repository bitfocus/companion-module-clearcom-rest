import { CompanionActionDefinitions, CompanionActionEvent, SomeCompanionActionInputField } from '@companion-module/base'
import ModuleInstance from './main.js'
import * as arcadia from './arcadia.js'
import { makeLogger } from './logger.js'
import { DeviceRequestError } from './network.js'
import { ControlDef, SettingValueType } from './types.js'

// ─── Value option builder ─────────────────────────────────────────────────────

type Choice = { id: string; label: string }

function valueChoices(vt: SettingValueType): Choice[] {
	if (vt.kind === 'integer') {
		const min = Math.max(vt.min, -100)
		const max = Math.min(vt.max, 100)
		if (vt.step === 0) return []
		const count = Math.floor((max - min) / vt.step) + 1
		if (count > 100) return []
		const choices: Choice[] = []
		for (let v = max; v >= min; v -= vt.step) choices.push({ id: String(v), label: String(v) })
		return choices
	}
	if (vt.kind === 'number-enum') {
		const sorted = [...vt.values].map((v, i) => ({ v, label: vt.labels?.[i] ?? String(v) })).sort((a, b) => b.v - a.v)
		return sorted.map(({ v, label }) => ({ id: String(v), label }))
	}
	if (vt.kind === 'string-enum') return vt.values.map((v) => ({ id: v, label: formatEnumLabel(v) }))
	if (vt.kind === 'boolean')
		return [
			{ id: 'true', label: 'Enabled' },
			{ id: 'false', label: 'Disabled' },
		]
	return []
}

function valueOption(def: ControlDef, choices: Choice[]): SomeCompanionActionInputField {
	if (def.valueType.kind === 'string') {
		return { type: 'textinput', id: 'value', label: 'Value', default: '' }
	}
	return {
		type: 'dropdown',
		id: 'value',
		label: 'Value',
		default: choices[0]?.id,
		choices,
		isVisibleExpression: "$(options:mode) == 'absolute'",
	}
}

function parseValue(raw: string, vt: SettingValueType): unknown {
	if (vt.kind === 'boolean') return raw === 'true'
	if (vt.kind === 'string' || vt.kind === 'string-enum') return raw
	return Number(raw)
}

function modeOptions(def: ControlDef): SomeCompanionActionInputField[] {
	if (!def.supportsIncDec) return []
	return [
		{
			type: 'dropdown',
			id: 'mode',
			label: 'Mode',
			default: 'absolute',
			disableAutoExpression: true,
			choices: [
				{ id: 'absolute', label: 'Absolute' },
				{ id: 'increment', label: 'Increment' },
				{ id: 'decrement', label: 'Decrement' },
			],
		},
	]
}

// ─── Enum label formatting ─────────────────────────────────────────────────────

const HEADSET_MIC_TYPE_LABELS: Record<string, string> = {
	dynamic_0: 'Dynamic (0dB)',
	dynamic_3: 'Dynamic (-3dB)',
	dynamic_6: 'Dynamic (-6dB)',
	dynamic_10: 'Dynamic (-10dB)',
	dynamic_12: 'Dynamic (-12dB)',
	dynamic_15: 'Dynamic (-15dB)',
	electret: 'Electret (-15dB)',
	electret_18: 'Electret (-18dB)',
	electret_21: 'Electret (-21dB)',
	dynamic_balanced: 'Dynamic Balanced',
	dynamic_unbalanced: 'Dynamic Unbalanced',
}

function formatEnumLabel(value: string): string {
	if (value in HEADSET_MIC_TYPE_LABELS) return HEADSET_MIC_TYPE_LABELS[value]
	return value
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.replace(/[-_]/g, ' ')
		.replace(/^\w/, (c) => c.toUpperCase())
}

// Converts activation state enum values to human-readable labels.
// Tokens: dual, force, talk, listen — where 'force' always modifies the next token.
// e.g. "talkforcelisten" → "Talk & Force Listen"
// e.g. "forcetalkforcelisten" → "Force Talk & Force Listen"
function activationStateLabel(value: string): string {
	const tokens = value.match(/dual|force|talk|listen/gi) ?? [value]
	// Group each token with any preceding 'force'/'dual' modifier
	const parts: string[] = []
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i].toLowerCase()
		if ((t === 'force' || t === 'dual') && i + 1 < tokens.length) {
			const next = tokens[++i]
			parts.push(
				t.charAt(0).toUpperCase() + t.slice(1) + ' ' + next.charAt(0).toUpperCase() + next.slice(1).toLowerCase(),
			)
		} else {
			parts.push(t.charAt(0).toUpperCase() + t.slice(1).toLowerCase())
		}
	}
	// Insert ' & ' before the 'listen' group (last part if more than one)
	if (parts.length > 1) parts.splice(parts.length - 1, 0, '&')
	return parts.join(' ')
}

// ─── Timeout wrapper ──────────────────────────────────────────────────────────

async function withTimeout(name: string, instance: ModuleInstance, fn: () => Promise<void>): Promise<void> {
	const log = makeLogger('actions', () => instance.config)
	const timeoutSentinel = Symbol('timeout')
	const result = await Promise.race([
		fn()
			.then(() => undefined)
			.catch((err: unknown) => err),
		new Promise<symbol>((resolve) => setTimeout(() => resolve(timeoutSentinel), 4000)),
	])
	if (result === timeoutSentinel) {
		log.error(`Action "${name}" timed out`)
	} else if (result instanceof Error && !(result instanceof DeviceRequestError)) {
		log.error(`Action "${name}" failed: ${result.message}`)
	}
}

// ─── Schema-driven actions ────────────────────────────────────────────────────

function buildDefsActions(instance: ModuleInstance): CompanionActionDefinitions {
	const actions: CompanionActionDefinitions = {}
	const rChoices = arcadia.roleChoices(instance)
	const epChoices = arcadia.endpointChoices(instance)

	const selectedTypes = instance.config.endpointTypes ?? []

	for (const def of instance.controlDefs) {
		if (!def.write) continue

		// Filter by selected device types if configured
		if (def.deviceTypes.length > 0 && selectedTypes.length > 0) {
			if (!def.deviceTypes.some((dt) => selectedTypes.includes(dt))) continue
		}

		// For action choices, use the most restrictive value type across all overrides.
		// This prevents showing invalid values for port types with tighter ranges (e.g. 2W gain).
		const effectiveVt = (() => {
			if (!def.perTypeOverride) return def.valueType
			const overrides = Object.values(def.perTypeOverride)
			// Pick the override with the fewest valid values (most restrictive)
			let most: SettingValueType = def.valueType
			for (const ov of overrides) {
				const ovCount =
					ov.kind === 'number-enum'
						? ov.values.length
						: ov.kind === 'integer' && ov.step > 0
							? Math.floor((ov.max - ov.min) / ov.step) + 1
							: Infinity
				const curCount =
					most.kind === 'number-enum'
						? most.values.length
						: most.kind === 'integer' && most.step > 0
							? Math.floor((most.max - most.min) / most.step) + 1
							: Infinity
				if (ovCount < curCount) most = ov
			}
			return most
		})()
		const choices = valueChoices(effectiveVt)

		const isKeyset = def.read?.store === ('keysets' as string)
		const isPort = def.scope === 'port'
		const isEndpoint = def.scope === 'endpoint'

		// Label/string fields target a single subject — multi-select would create duplicates
		const isSingleSubject = def.valueType.kind === 'string'
		const subjectOption: SomeCompanionActionInputField = isPort
			? isSingleSubject
				? {
						type: 'dropdown',
						id: 'ids',
						label: 'Port',
						default: arcadia.portChoices(instance)[0]?.id,
						choices: arcadia.portChoices(instance),
					}
				: { type: 'multidropdown', id: 'ids', label: 'Port', default: [], choices: arcadia.portChoices(instance) }
			: isEndpoint
				? isSingleSubject
					? { type: 'dropdown', id: 'ids', label: 'Endpoint', default: epChoices[0]?.id, choices: epChoices }
					: { type: 'multidropdown', id: 'ids', label: 'Endpoint', default: [], choices: epChoices }
				: isSingleSubject
					? { type: 'dropdown', id: 'ids', label: 'Role', default: rChoices[0]?.id, choices: rChoices }
					: { type: 'multidropdown', id: 'ids', label: 'Role', default: [], choices: rChoices }

		const typePrefix = def.deviceTypes.length === 1 ? `[${def.deviceTypes[0]}] ` : ''
		const scopePrefix = isPort
			? '[Port] '
			: isEndpoint
				? '[Endpoint] '
				: isKeyset && def.deviceTypes.length === 1
					? ''
					: '[Role] '

		actions[def.id.replace(/\./g, '_')] = {
			name: `${typePrefix}${scopePrefix}${def.label}`,
			description: def.description,
			options: [subjectOption, ...modeOptions(def), valueOption(def, choices)],
			callback: async (action: CompanionActionEvent) => {
				const raw = action.options['ids']
				const ids = (Array.isArray(raw) ? (raw as string[]) : [raw as string]).map(Number)
				const mode = (action.options['mode'] as 'absolute' | 'increment' | 'decrement' | undefined) ?? 'absolute'
				const value = parseValue(action.options['value'] as string, effectiveVt)

				await withTimeout(def.id, instance, async () => {
					if (isKeyset) {
						const deviceType = def.deviceTypes[0]
						await arcadia.setKeyset(instance, ids, def, value, mode, deviceType)
					} else {
						for (const id of ids) {
							await arcadia.executeWrite(instance, def, id, value, mode)
						}
					}
				})
			},
		}
	}

	return actions
}

// ─── Manual actions ───────────────────────────────────────────────────────────

function buildManualActions(instance: ModuleInstance): CompanionActionDefinitions {
	const rChoices = arcadia.roleChoices(instance)
	const selectedTypes = instance.config.endpointTypes ?? []

	const assignToChoices: Choice[] = [
		{ id: '', label: '(empty)' },
		{ id: 'special:call', label: 'Special: Call' },
		...[...instance.connections.values()].map((c) => ({
			id: `conn:${c['id'] as string}`,
			label: `Channel: ${c['label'] as string}`,
		})),
		...[...instance.rolesets.values()].map((r) => ({
			id: `role:${r['id'] as string}`,
			label: `Role: ${r['name'] as string}`,
		})),
		...[...instance.ports.values()]
			.filter((p) => !(p['port_settings'] as Record<string, unknown> | undefined)?.['port_splitLabel'])
			.map((p) => ({ id: `port:${p['port_id'] as string}`, label: `Port: ${p['port_label'] as string}` })),
		...[...instance.ports.values()]
			.filter((p) => (p['port_settings'] as Record<string, unknown> | undefined)?.['port_splitLabel'])
			.map((p) => ({ id: `port:${p['port_id'] as string}`, label: `Split: ${p['port_label'] as string}` })),
	]

	const actions: CompanionActionDefinitions = {
		call: {
			name: '[Role] Call',
			description: 'Send a call notification to a beltpack role.',
			options: [
				{
					type: 'multidropdown',
					id: 'roleIds',
					label: 'Beltpack',
					default: [],
					choices: [{ id: '', label: 'All' }, ...rChoices],
				},
				{
					type: 'dropdown',
					id: 'active',
					label: 'Active',
					default: 'true',
					choices: [
						{ id: 'true', label: 'Call' },
						{ id: 'false', label: 'Stop' },
					],
				},
				{ type: 'textinput', id: 'text', label: 'Text', default: '' },
			],
			callback: async (action: CompanionActionEvent) => {
				const roleIds = action.options['roleIds'] as string[]
				const active = action.options['active'] === 'true'
				const text = action.options['text'] as string
				await withTimeout('call', instance, async () => {
					for (const roleId of roleIds) await arcadia.sendCall(instance, roleId, active, text)
				})
			},
		},
		assign_role: {
			name: '[Endpoint] Assign Role',
			description: 'Change association for the endpoint attached to the device.',
			options: [
				{
					type: 'dropdown',
					id: 'endpointId',
					label: 'Endpoint',
					default: arcadia.endpointChoices(instance)[0]?.id,
					choices: arcadia.endpointChoices(instance),
				},
				{
					type: 'dropdown',
					id: 'rolesetGid',
					label: 'Role',
					default: '',
					choices: [
						{ id: '', label: '(remove)' },
						...[...instance.rolesets.values()].map((r) => ({
							id: r['gid'] as string,
							label: (r['label'] ?? r['name']) as string,
						})),
					],
				},
			],
			callback: async (action: CompanionActionEvent) => {
				const endpointId = Number(action.options['endpointId'])
				const gid = action.options['rolesetGid'] as string
				await withTimeout('assign_role', instance, async () => {
					await arcadia.changeEndpointAssociation(instance, endpointId, gid || null)
				})
			},
		},

		remote_mic_kill: {
			name: '[Role] Remote Mic Kill (RMK)',
			description: 'Remotely mute the microphone on a beltpack.',
			options: [
				{
					type: 'multidropdown',
					id: 'roleIds',
					label: 'Beltpack',
					default: [],
					choices: [{ id: '', label: 'All' }, ...rChoices],
				},
			],
			callback: async (action: CompanionActionEvent) => {
				const selected = action.options['roleIds'] as string[]
				await withTimeout('remote_mic_kill', instance, async () => {
					for (const id of selected) await arcadia.remoteMicKill(instance, id)
				})
			},
		},
	}

	// Nulling — only for 2W ports
	const twoPorts = [...instance.ports.values()].filter((p) => p['port_config_type'] === '2W')
	if (twoPorts.length > 0) {
		const twoPChoices = twoPorts.map((p) => ({
			id: String(p['port_id']),
			label: p['port_desc'] ? `${p['port_label'] as string} (${p['port_desc'] as string})` : String(p['port_label']),
		}))
		actions['port_2w_start_nulling'] = {
			name: '[2W] Start Nulling',
			description: 'Start the nulling process on a port. Only available on 2W ports.',
			options: [{ type: 'multidropdown', id: 'portIds', label: 'Port', default: [], choices: twoPChoices }],
			callback: async (action: CompanionActionEvent) => {
				const portIds = (action.options['portIds'] as string[]).map(Number)
				await withTimeout('port_2w_start_nulling', instance, async () => {
					await arcadia.startNulling(instance, portIds)
				})
			},
		}
	}

	// Key assign — one action per device type, driven by keyAssignCapabilities
	const filteredCaps = Object.entries(instance.keyAssignCapabilities).filter(
		([dt]) => selectedTypes.length === 0 || selectedTypes.includes(dt),
	)

	for (const [deviceType, caps] of filteredCaps) {
		const keyChoices = Array.from({ length: caps.keyCount }, (_, i) => ({ id: String(i), label: `Key ${i + 1}` }))
		const talkModeChoices = caps.talkBtnModes.map((m) => ({ id: m, label: formatEnumLabel(m) }))

		const opts: SomeCompanionActionInputField[] = [
			{ type: 'multidropdown', id: 'roleIds', label: 'Role', default: [], choices: rChoices },
			{ type: 'dropdown', id: 'keyIndex', label: 'Key Slot', default: '0', choices: keyChoices },
			{ type: 'dropdown', id: 'assignTo', label: 'Assign To', default: '', choices: assignToChoices },
		]

		if (caps.activationStates) {
			opts.push({
				type: 'dropdown',
				id: 'activationState',
				label: 'Key Mode',
				default: caps.activationStates[0],
				choices: caps.activationStates.map((s) => ({ id: s, label: activationStateLabel(s) })),
			})
		}

		opts.push({
			type: 'dropdown',
			id: 'talkBtnMode',
			label: 'Talk Button Mode',
			default: talkModeChoices[0]?.id,
			choices: talkModeChoices,
		})

		// Learn: read current key assignment from cached keyset
		const dtKey = deviceType.replace(/[^a-z0-9]/gi, '_').toLowerCase()
		actions[`assign_key_${dtKey}`] = {
			name: `[${deviceType}] Assign Key`,
			description: 'Assign a channel, connection, or role to a key slot on a beltpack.',
			options: opts,
			learn: (action) => {
				const roleId = (action.options['roleIds'] as string[])[0]
				if (!roleId) return undefined
				const keysetId = arcadia.findKeysetIdForRole(instance, Number(roleId), deviceType)
				if (keysetId === undefined) return undefined
				const keyset = instance.keysets.get(keysetId)
				if (!keyset) return undefined
				const slots = ((keyset['settings'] as Record<string, unknown>)?.['keysets'] ?? []) as Record<string, unknown>[]
				const slot = slots.find((s) => (s['keysetIndex'] as number) === Number(action.options['keyIndex']))
				if (!slot) return undefined
				const entities = slot['entities'] as Record<string, unknown>[] | undefined
				const entity = entities?.[0]
				let assignTo = ''
				if (entity) {
					const res = entity['res'] as string
					if (res === '/api/1/special/call') assignTo = 'special:call'
					else if (entity['type'] === 3) assignTo = `role:${res.split('/').pop()}`
					else if (entity['type'] === 0) assignTo = `conn:${res.split('/').pop()}`
					else if (entity['type'] === 1) assignTo = `port:${res.split('/').pop()}`
				}
				const activationState = slot['activationState'] as string | undefined
				const talkBtnMode = slot['talkBtnMode'] as string | undefined
				if (talkBtnMode === undefined) return undefined
				return {
					...action.options,
					assignTo,
					activationState,
					talkBtnMode,
				}
			},
			callback: async (action: CompanionActionEvent) => {
				const roleIds = (action.options['roleIds'] as string[]).map(Number)
				await withTimeout(`assign_key_${deviceType}`, instance, async () => {
					await arcadia.assignKeyChannel(
						instance,
						roleIds,
						Number(action.options['keyIndex']),
						action.options['assignTo'] as string,
						action.options['activationState'] as string,
						action.options['talkBtnMode'] as string,
						deviceType,
					)
				})
			},
		}
	}

	return actions
}

// ─── Public entry point ───────────────────────────────────────────────────────

export function UpdateActions(instance: ModuleInstance): void {
	instance.setActionDefinitions({
		...buildDefsActions(instance),
		...buildManualActions(instance),
	})
}
