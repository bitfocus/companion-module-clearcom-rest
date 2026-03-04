import { CompanionActionDefinitions, CompanionActionEvent, SomeCompanionActionInputField } from '@companion-module/base'
import ModuleInstance from './main.js'
import * as arcadia from './arcadia.js'
import { ControlDef, SettingValueType } from './types.js'

// ─── Value option builder ─────────────────────────────────────────────────────

type Choice = { id: string; label: string }

function valueChoices(vt: SettingValueType): Choice[] {
	if (vt.kind === 'integer') {
		const choices: Choice[] = []
		for (let v = vt.max; v >= vt.min; v -= vt.step) choices.push({ id: String(v), label: String(v) })
		return choices
	}
	if (vt.kind === 'number-enum')
		return [...vt.values].sort((a, b) => b - a).map((v) => ({ id: String(v), label: String(v) }))
	if (vt.kind === 'string-enum') return vt.values.map((v) => ({ id: v, label: v }))
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
		default: choices[0]?.id ?? '',
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

// ─── Format schema enum label ─────────────────────────────────────────────────

function formatEnumLabel(value: string): string {
	const tokens = ['forcetalk', 'force', 'dual', 'talk', 'listen', 'latching', 'non-latching', 'disabled', 'permanent']
	let remaining = value
	const parts: string[] = []
	while (remaining.length > 0) {
		const match = tokens.find((t) => remaining.startsWith(t))
		if (match) {
			if (match == 'forcetalk') {
				parts.push('Force', 'Talk')
			} else {
				parts.push(match.charAt(0).toUpperCase() + match.slice(1))
			}
			if (parts[parts.length - 1] == 'Talk') parts.push('&')
			remaining = remaining.slice(match.length)
		} else {
			parts.push(remaining.charAt(0).toUpperCase() + remaining.slice(1))
			break
		}
	}
	if (parts.length < 3 && ['Talk', 'Listen'].includes(parts[0])) parts[1] = 'Only'
	return parts.join(' ')
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

		const effectiveVt = def.valueType
		const choices = valueChoices(effectiveVt)

		const isKeyset = def.read?.store === ('keysets' as string)
		const isPort = def.scope === 'port'
		const isEndpoint = def.scope === 'endpoint'

		// Build the subject dropdown (who this applies to)
		const subjectOption: SomeCompanionActionInputField = isPort
			? { type: 'multidropdown', id: 'ids', label: 'Port', default: [], choices: arcadia.portChoices(instance) }
			: isEndpoint
				? { type: 'multidropdown', id: 'ids', label: 'Endpoint', default: [], choices: epChoices }
				: { type: 'multidropdown', id: 'ids', label: 'Role', default: [], choices: rChoices }

		const typePrefix = def.deviceTypes.length === 1 ? `[${def.deviceTypes[0]}] ` : ''
		const scopePrefix = isPort ? '[Port] ' : isEndpoint ? '[Endpoint] ' : isKeyset ? '' : '[Role] '

		actions[def.id.replace(/\./g, '_')] = {
			name: `${typePrefix}${scopePrefix}${def.label}`,
			description: def.description,
			options: [subjectOption, ...modeOptions(def), valueOption(def, choices)],
			callback: async (action: CompanionActionEvent) => {
				const ids = (action.options['ids'] as string[]).map(Number)
				const mode = (action.options['mode'] as 'absolute' | 'increment' | 'decrement' | undefined) ?? 'absolute'
				const value = parseValue(action.options['value'] as string, effectiveVt)

				if (isKeyset) {
					await arcadia.setKeyset(instance, ids, def, value, mode)
				} else {
					for (const id of ids) {
						await arcadia.executeWrite(instance, def, id, value, mode)
					}
				}
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
			name: 'Call Beltpack',
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
				for (const roleId of roleIds) await arcadia.sendCall(instance, roleId, active, text)
			},
		},
		assign_role: {
			name: 'Assign Role to Endpoint',
			description: 'Change association for the endpoint attached to the device.',
			options: [
				{
					type: 'dropdown',
					id: 'endpointId',
					label: 'Endpoint',
					default: arcadia.endpointChoices(instance)[0]?.id ?? '',
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
				await arcadia.changeEndpointAssociation(instance, endpointId, gid || null)
			},
		},

		remote_mic_kill: {
			name: 'Remote Mic Kill (RMK)',
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
				for (const id of selected) await arcadia.remoteMicKill(instance, id)
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
				await arcadia.startNulling(instance, portIds)
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
				default: caps.activationStates[0] ?? '',
				choices: caps.activationStates.map((s) => ({ id: s, label: formatEnumLabel(s) })),
			})
		}

		opts.push({
			type: 'dropdown',
			id: 'talkBtnMode',
			label: 'Talk Button Mode',
			default: talkModeChoices[0]?.id ?? '',
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
				const roleset = instance.rolesets.get(Number(roleId))
				if (!roleset) return undefined
				const sessions = roleset['sessions'] as Record<string, unknown> | undefined
				const firstSession = sessions ? (Object.values(sessions)[0] as Record<string, unknown> | undefined) : undefined
				const settingsObj = (firstSession?.['data'] as Record<string, unknown> | undefined)?.['settings'] as
					| Record<string, unknown>
					| undefined
				const keysetId = settingsObj?.['defaultRole'] as number | undefined
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
				return {
					...action.options,
					assignTo,
					activationState: (slot['activationState'] as string) ?? '',
					talkBtnMode: (slot['talkBtnMode'] as string) ?? '',
				}
			},
			callback: async (action: CompanionActionEvent) => {
				const roleIds = (action.options['roleIds'] as string[]).map(Number)
				await arcadia.assignKeyChannel(
					instance,
					roleIds,
					Number(action.options['keyIndex']),
					action.options['assignTo'] as string,
					(action.options['activationState'] as string) ?? '',
					action.options['talkBtnMode'] as string,
				)
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
