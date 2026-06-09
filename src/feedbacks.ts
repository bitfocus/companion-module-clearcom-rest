import {
	CompanionAdvancedFeedbackDefinition,
	CompanionBooleanFeedbackDefinition,
	CompanionFeedbackDefinitions,
	CompanionFeedbackButtonStyleResult,
	CompanionOptionValues,
	JsonValue,
} from '@companion-module/base'
import ModuleInstance from './main.js'
import { getField, roleChoices, endpointChoices, portChoices, findKeysetIdForRole } from './arcadia.js'
import { ControlDef, DeviceRecord } from './types.js'
import { drawMeter, MeterStyle } from './indicators.js'

function subscribe(instance: ModuleInstance, feedbackId: string, store: string): void {
	instance.feedbackTriggers.set(feedbackId, store as import('./types.js').FeedbackStore)
}

function unsubscribeFn(instance: ModuleInstance) {
	return (feedback: { feedbackId: string }): void => {
		instance.feedbackTriggers.delete(feedback.feedbackId)
	}
}

function getKeysetForRole(instance: ModuleInstance, roleId: number, deviceType?: string): DeviceRecord | null {
	if (!deviceType) return null
	const keysetId = findKeysetIdForRole(instance, roleId, deviceType)
	return keysetId !== undefined ? (instance.keysets.get(keysetId) ?? null) : null
}

function getStatusForRole(instance: ModuleInstance, roleId: number): DeviceRecord | null {
	for (const [, status] of instance.endpointStatus) {
		const assoc = status['association'] as DeviceRecord | undefined
		if ((assoc?.['dpId'] as number | undefined) === roleId) return status
	}
	return null
}

interface CompanionValueFeedbackDefinition {
	type: 'value'
	name: string
	description?: string
	options: Record<string, unknown>[]
	callback: (feedback: { feedbackId: string; options: CompanionOptionValues }) => JsonValue
	unsubscribe?: (feedback: { feedbackId: string }) => void
}

type FeedbackDef =
	| CompanionBooleanFeedbackDefinition
	| CompanionAdvancedFeedbackDefinition
	| CompanionValueFeedbackDefinition

function buildDefsFor(
	instance: ModuleInstance,
	def: ControlDef,
	rChoices: ReturnType<typeof roleChoices>,
	epChoices: ReturnType<typeof endpointChoices>,
	pChoices: ReturnType<typeof portChoices>,
): FeedbackDef | null {
	if (!def.read) return null

	const isPort = def.scope === 'port'
	const isEndpoint = def.scope === 'endpoint'
	const isKeyset = def.read.store === 'keysets'
	const isLiveStatus = def.read.store === 'endpointStatus'
	const store = def.read.store

	const subjectOption = isPort
		? ({ type: 'dropdown', id: 'subjectId', label: 'Port', default: pChoices[0]?.id, choices: pChoices } as const)
		: isEndpoint
			? ({
					type: 'dropdown',
					id: 'subjectId',
					label: 'Endpoint',
					default: epChoices[0]?.id,
					choices: epChoices,
				} as const)
			: ({ type: 'dropdown', id: 'subjectId', label: 'Role', default: rChoices[0]?.id, choices: rChoices } as const)

	const typePrefix = def.deviceTypes.length === 1 ? `[${def.deviceTypes[0]}] ` : ''
	const scopePrefix = isPort
		? '[Port] '
		: isEndpoint || isLiveStatus
			? '[Beltpack] '
			: isKeyset && def.deviceTypes.length === 1
				? ''
				: '[Role] '
	const name = `${typePrefix}${scopePrefix}${def.label}`

	const getValue = (subjectId: number): unknown => {
		if (isPort) {
			const record = instance.ports.get(subjectId)
			return record ? getField(record, def.read!.field) : null
		}
		if (isLiveStatus) {
			const status = instance.endpointStatus.get(subjectId)
			const val = status ? getField(status, def.read!.field) : null
			if (def.read!.field.startsWith('longevity.') && typeof val === 'number') {
				return String(val).padStart(2, '0')
			}
			return val
		}
		if (isKeyset) {
			const deviceType = def.deviceTypes[0]
			const keyset = deviceType
				? getKeysetForRole(instance, subjectId, deviceType)
				: Object.keys(instance.keyAssignCapabilities).reduce<DeviceRecord | null>(
						(found, dt) => found ?? getKeysetForRole(instance, subjectId, dt),
						null,
					)
			return keyset ? getField(keyset, def.read!.field) : null
		}
		if (isEndpoint) {
			const record = instance.endpoints.get(subjectId)
			return record ? getField(record, def.read!.field) : null
		}
		const record = instance.rolesets.get(subjectId)
		return record ? getField(record, def.read!.field) : null
	}

	if (def.valueType.kind === 'boolean') {
		return {
			type: 'boolean',
			name,
			description: def.description,
			defaultStyle: { bgcolor: 0x00ff00, color: 0x000000 } satisfies Partial<CompanionFeedbackButtonStyleResult>,
			options: [subjectOption],
			unsubscribe: unsubscribeFn(instance),
			callback: (feedback: { feedbackId: string; options: Record<string, unknown> }) => {
				subscribe(instance, feedback.feedbackId, store)
				const val = getValue(Number(feedback.options['subjectId']))
				return val === true || val === 'online'
			},
		}
	}

	return {
		type: 'value',
		name,
		description: def.description,
		options: [subjectOption],
		unsubscribe: unsubscribeFn(instance),
		callback: (feedback: { feedbackId: string; options: Record<string, unknown> }) => {
			subscribe(instance, feedback.feedbackId, store)
			return getValue(Number(feedback.options['subjectId'])) as JsonValue
		},
	}
}

function buildDefsFeedbacks(instance: ModuleInstance): Record<string, FeedbackDef> {
	const feedbacks: Record<string, FeedbackDef> = {}
	const rChoices = roleChoices(instance)
	const epChoices = endpointChoices(instance)
	const pChoices = portChoices(instance)

	const selectedTypes = instance.config.endpointTypes ?? []

	for (const def of instance.controlDefs) {
		if (!def.read) continue
		if (def.deviceTypes.length > 0 && selectedTypes.length > 0) {
			if (!def.deviceTypes.some((dt) => selectedTypes.includes(dt))) continue
		}
		const fb = buildDefsFor(instance, def, rChoices, epChoices, pChoices)
		if (fb) feedbacks[def.id.replace(/\./g, '_')] = fb
	}

	return feedbacks
}

function buildManualFeedbacks(instance: ModuleInstance): Record<string, FeedbackDef> {
	const rChoices = roleChoices(instance)
	const epChoices = endpointChoices(instance)

	const roleOption = {
		type: 'dropdown' as const,
		id: 'roleId',
		label: 'Role',
		default: rChoices[0]?.id,
		choices: rChoices,
	}
	const epOption = {
		type: 'dropdown' as const,
		id: 'endpointId',
		label: 'Beltpack',
		default: epChoices[0]?.id,
		choices: epChoices,
	}

	const selectedTypes = instance.config.endpointTypes ?? []
	const filteredCaps = Object.entries(instance.keyAssignCapabilities).filter(
		([dt]) => selectedTypes.length === 0 || selectedTypes.includes(dt),
	)
	const maxKeys = Math.max(1, ...filteredCaps.map(([, c]) => c.keyCount))
	const keyChoices = Array.from({ length: maxKeys }, (_, i) => ({ id: String(i), label: `Key ${i + 1}` }))
	const keyOption = { type: 'dropdown' as const, id: 'keyIndex', label: 'Key', default: '0', choices: keyChoices }

	const getKeyState = (roleId: number, keyIndex: string) => {
		const status = getStatusForRole(instance, roleId)
		return (status?.['keyState'] as DeviceRecord | undefined)?.[keyIndex] as DeviceRecord | undefined
	}

	const getKeyAssign = (roleId: number, keyIndex: number): string => {
		let keyset: DeviceRecord | null = null
		for (const deviceType of Object.keys(instance.keyAssignCapabilities)) {
			const ks = getKeysetForRole(instance, roleId, deviceType)
			if (ks) {
				keyset = ks
				break
			}
		}
		if (!keyset) return ''
		const slots = ((keyset['settings'] as DeviceRecord | undefined)?.['keysets'] ?? []) as DeviceRecord[]
		const slot = slots.find((s) => (s['keysetIndex'] as number) === keyIndex)
		if (!slot) return ''
		const entities = (slot['entities'] as DeviceRecord[] | undefined) ?? []
		const entity = entities[0]
		if (!entity) return '(empty)'
		const res = entity['res'] as string
		if (res === '/api/1/special/call') return 'Special: Call'
		const id = Number(res.split('/').pop())
		if (entity['type'] === 3)
			return (instance.rolesets.get(id)?.['name'] as string | undefined) ?? `(unknown role ${id})`
		if (entity['type'] === 0)
			return (instance.connections.get(id)?.['label'] as string | undefined) ?? `(unknown conn ${id})`
		if (entity['type'] === 1)
			return (instance.ports.get(id)?.['port_label'] as string | undefined) ?? `(unknown port ${id})`
		return `(unknown entity type ${entity['type'] as string})`
	}

	const feedbacks: Record<string, FeedbackDef> = {
		key_state: {
			type: 'value',
			name: '[Key] State',
			options: [roleOption, keyOption],
			unsubscribe: unsubscribeFn(instance),
			callback: (feedback: { feedbackId: string; options: Record<string, unknown> }) => {
				subscribe(instance, feedback.feedbackId, 'endpointStatus')
				const k = getKeyState(Number(feedback.options['roleId']), feedback.options['keyIndex'] as string)
				return (k?.['currentState'] ?? false) as JsonValue
			},
		},

		key_volume: {
			type: 'value',
			name: '[Key] Volume',
			options: [roleOption, keyOption],
			unsubscribe: unsubscribeFn(instance),
			callback: (feedback: { feedbackId: string; options: Record<string, unknown> }) => {
				subscribe(instance, feedback.feedbackId, 'endpointStatus')
				const k = getKeyState(Number(feedback.options['roleId']), feedback.options['keyIndex'] as string)
				return (k?.['volume'] ?? false) as JsonValue
			},
		},

		key_assign: {
			type: 'value',
			name: '[Key] Assignment',
			options: [roleOption, keyOption],
			unsubscribe: unsubscribeFn(instance),
			callback: (feedback: { feedbackId: string; options: Record<string, unknown> }) => {
				subscribe(instance, feedback.feedbackId, 'keysets')
				return getKeyAssign(Number(feedback.options['roleId']), Number(feedback.options['keyIndex'])) || false
			},
		},

		role_endpoint: {
			type: 'value',
			name: '[Role] Assigned Endpoint ID',
			description: 'Returns the endpoint ID currently assigned to this role (via association.dpId)',
			options: [roleOption],
			unsubscribe: unsubscribeFn(instance),
			callback: (feedback: { feedbackId: string; options: Record<string, unknown> }) => {
				subscribe(instance, feedback.feedbackId, 'endpointStatus')
				const roleId = Number(feedback.options['roleId'])
				for (const [epId, status] of instance.endpointStatus) {
					const dpId = (status['association'] as DeviceRecord | undefined)?.['dpId'] as number | undefined
					if (dpId === roleId) return epId
				}
				return false
			},
		},

		beltpack_role: {
			type: 'value',
			name: '[Beltpack] Assigned Role',
			options: [epOption],
			unsubscribe: unsubscribeFn(instance),
			callback: (feedback: { feedbackId: string; options: Record<string, unknown> }) => {
				subscribe(instance, feedback.feedbackId, 'endpointStatus')
				const status = instance.endpointStatus.get(Number(feedback.options['endpointId']))
				const dpId = (status?.['association'] as DeviceRecord | undefined)?.['dpId'] as number | undefined
				return dpId ?? false
			},
		},

		gateway_online: {
			type: 'boolean',
			name: '[Antenna] Online',
			defaultStyle: { bgcolor: 0x00ff00, color: 0x000000 } satisfies Partial<CompanionFeedbackButtonStyleResult>,
			options: [
				{
					type: 'dropdown' as const,
					id: 'endpointId',
					label: 'Antenna',
					default: [...instance.gateways.keys()][0]?.toString(),
					choices: [...instance.gateways.values()].map((g) => ({ id: String(g['id']), label: String(g['label']) })),
				},
			],
			unsubscribe: unsubscribeFn(instance),
			callback: (feedback: { feedbackId: string; options: Record<string, unknown> }) => {
				subscribe(instance, feedback.feedbackId, 'endpoints')
				const gw = instance.gateways.get(Number(feedback.options['endpointId']))
				const status = (gw?.['liveStatus'] as DeviceRecord | undefined)?.['status']
				return status === 'online'
			},
		},

		gateway_status: {
			type: 'value',
			name: '[Antenna] Status',
			options: [
				{
					type: 'dropdown' as const,
					id: 'endpointId',
					label: 'Antenna',
					default: [...instance.gateways.keys()][0]?.toString(),
					choices: [...instance.gateways.values()].map((g) => ({ id: String(g['id']), label: String(g['label']) })),
				},
			],
			unsubscribe: unsubscribeFn(instance),
			callback: (feedback: { feedbackId: string; options: Record<string, unknown> }) => {
				subscribe(instance, feedback.feedbackId, 'endpoints')
				const gw = instance.gateways.get(Number(feedback.options['endpointId']))
				return ((gw?.['liveStatus'] as DeviceRecord | undefined)?.['status'] ?? false) as JsonValue
			},
		},

		call_from: {
			type: 'value',
			name: 'Call From',
			description: 'Label of the beltpack currently sending a call (from connections liveStatus)',
			options: [],
			unsubscribe: unsubscribeFn(instance),
			callback: (feedback: { feedbackId: string; options: Record<string, unknown> }) => {
				subscribe(instance, feedback.feedbackId, 'connections')
				for (const conn of instance.connections.values()) {
					const participants = (conn['participants'] as DeviceRecord[] | undefined) ?? []
					for (const p of participants) {
						if ((p['events'] as DeviceRecord | undefined)?.['call']) {
							return p['label'] as JsonValue
						}
					}
				}
				return false
			},
		},

		call_to: {
			type: 'value',
			name: 'Call To',
			description: 'Label of the beltpack receiving an active inbound call (from endpointStatus.callState)',
			options: [],
			unsubscribe: unsubscribeFn(instance),
			callback: (feedback: { feedbackId: string; options: Record<string, unknown> }) => {
				subscribe(instance, feedback.feedbackId, 'endpointStatus')
				for (const [epId, status] of instance.endpointStatus) {
					if (status['callState'] === true) {
						const ep = instance.endpoints.get(epId)
						return (ep?.['label'] as string | undefined) ?? String(epId)
					}
				}
				return false
			},
		},

		call_on_connection: {
			type: 'boolean',
			name: 'Calling',
			description: 'True when any participant is calling on the selected connection',
			defaultStyle: { bgcolor: 0xff0000, color: 0xffffff },
			options: [
				{
					type: 'dropdown' as const,
					id: 'connectionId',
					label: 'Connection',
					default: [...instance.connections.keys()][0]?.toString(),
					choices: [...instance.connections.values()].map((c) => ({
						id: String(c['id']),
						label: c['label'] as string,
					})),
				},
			],
			unsubscribe: unsubscribeFn(instance),
			callback: (feedback: { feedbackId: string; options: Record<string, unknown> }) => {
				subscribe(instance, feedback.feedbackId, 'connections')
				const connId = Number(feedback.options['connectionId'])
				const conn = instance.connections.get(connId)
				if (!conn) return false
				const participants = (conn['participants'] as DeviceRecord[] | undefined) ?? []
				return participants.some((p) => (p['events'] as DeviceRecord | undefined)?.['call'])
			},
		},

		...([...instance.ports.values()].some((p) => p['port_config_type'] === '2W')
			? {
					port_2w_nulling_status: {
						type: 'value',
						name: '[2W] Nulling Status',
						options: [
							{
								type: 'dropdown' as const,
								id: 'portId',
								label: 'Port',
								default: portChoices(instance).find((p) => {
									const port = [...instance.ports.values()].find((pr) => String(pr['port_id']) === p.id)
									return port?.['port_config_type'] === '2W'
								})?.id,
								choices: portChoices(instance).filter((p) => {
									const port = instance.ports.get(Number(p.id))
									return port?.['port_config_type'] === '2W'
								}),
							},
						],
						unsubscribe: unsubscribeFn(instance),
						callback: (feedback: { feedbackId: string; options: Record<string, unknown> }) => {
							subscribe(instance, feedback.feedbackId, 'nulling')
							return instance.nullingStatus.get(Number(feedback.options['portId'])) as JsonValue
						},
					},
				}
			: {}),

		gpi_triggered: {
			type: 'boolean',
			name: '[NEP] GPI Triggered',
			description: 'True when the specified GPI index was last asserted via a Trigger GPI action.',
			defaultStyle: { bgcolor: 0xff8800, color: 0x000000 },
			options: [
				{
					type: 'dropdown' as const,
					id: 'gpiId',
					label: 'GPI',
					default: '0',
					choices: Array.from({ length: instance.gpiCount || 1 }, (_, i) => ({
						id: String(i),
						label: `GPI ${i + 1}`,
					})),
				},
			],
			unsubscribe: unsubscribeFn(instance),
			callback: (feedback: { feedbackId: string; options: Record<string, unknown> }) => {
				subscribe(instance, feedback.feedbackId, 'gpi')
				return instance.gpiState.get(Number(feedback.options['gpiId'])) === true
			},
		},
	}

	return feedbacks
}

function buildMeterFeedback(): Record<string, CompanionAdvancedFeedbackDefinition> {
	return {
		meter: {
			type: 'advanced',
			name: '[Meter]',
			options: [
				{
					type: 'dropdown',
					id: 'style',
					label: 'Style',
					default: 'bar-horizontal',
					choices: [
						{ id: 'bar-horizontal', label: 'Bar (horizontal)' },
						{ id: 'bar-vertical', label: 'Bar (vertical)' },
						{ id: 'circle', label: 'Circle' },
					],
				},
				{ type: 'number', id: 'thickness', label: 'Thickness', default: 8, min: 1, max: 36 },
				{ type: 'number', id: 'x', label: 'X Position', default: 0, min: -60, max: 60 },
				{ type: 'number', id: 'y', label: 'Y Position', default: 0, min: -60, max: 60 },
				{ type: 'number', id: 'scale', label: 'Scale', default: 1, min: 0.2, max: 1, step: 0.01, range: true },
				{ type: 'number', id: 'min', label: 'Min', default: 0, min: -999, max: 999 },
				{ type: 'number', id: 'max', label: 'Max', default: 100, min: -999, max: 999 },
				{
					type: 'number',
					id: 'yellowStart',
					label: 'Yellow From',
					default: 50,
					min: -999,
					max: 999,
					tooltip: 'Make Yellow > Red to reverse the colors',
				},
				{
					type: 'number',
					id: 'redStart',
					label: 'Red From',
					default: 75,
					min: -999,
					max: 999,
					tooltip: 'Make Yellow > Red to reverse the colors',
				},
				{ type: 'textinput', id: 'value', label: 'Value', default: '0' },
			],
			callback: (feedback) =>
				drawMeter({
					style: feedback.options['style'] as MeterStyle,
					thickness: Number(feedback.options['thickness']),
					x: Number(feedback.options['x']),
					y: Number(feedback.options['y']),
					min: Number(feedback.options['min']),
					max: Number(feedback.options['max']),
					yellowStart: Number(feedback.options['yellowStart']),
					redStart: Number(feedback.options['redStart']),
					scale: Number(feedback.options['scale']),
					value: Number(feedback.options['value']),
					width: feedback.image?.width,
					height: feedback.image?.height,
				}),
		},
	}
}

export function UpdateFeedbacks(instance: ModuleInstance): void {
	instance.setFeedbackDefinitions({
		...buildDefsFeedbacks(instance),
		...buildManualFeedbacks(instance),
		...buildMeterFeedback(),
	} as CompanionFeedbackDefinitions)
}
