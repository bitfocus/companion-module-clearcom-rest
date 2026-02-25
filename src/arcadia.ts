import ModuleInstance from './main.js'
import { getRequest, postRequest, putRequest } from './rest.js'
import { BeltpackEndpoint } from './types.js'

// ─── Commands ─────────────────────────────────────────────────────────────────

export async function remoteMicKill(instance: ModuleInstance, roleId: string): Promise<void> {
	let endpointId: number | null = null

	if (roleId) {
		endpointId =
			[...instance.beltpackStatus.keys()].find(
				(id) => instance.beltpackStatus.get(id)?.association?.dpId === Number(roleId),
			) ?? null
		if (endpointId === null) {
			instance.log('warn', `RMK: no online beltpack found for role ${roleId}`)
			return
		}
	}

	const epSegment = endpointId !== null ? `/${endpointId}` : ''
	const endpoint = `http://${instance.config.host}/api/1/devices/1/endpoints${epSegment}/rmk`
	try {
		const response = await postRequest<{ ok: boolean }>(endpoint, instance)
		instance.log('info', `RMK sent (role=${roleId || 'all'}): ${JSON.stringify(response, null, 2)}`)
	} catch (error) {
		instance.log('error', `Failed to send RMK (role=${roleId || 'all'}): ${String(error)}`)
	}
}

export async function getLiveStatus(instance: ModuleInstance): Promise<BeltpackEndpoint[] | null> {
	try {
		return await getRequest<BeltpackEndpoint[]>(`http://${instance.config.host}/api/1/connections/liveStatus`, instance)
	} catch (error) {
		instance.log('error', `Failed to get live status: ${String(error)}`)
		return null
	}
}

export async function setInputGain(
	instance: ModuleInstance,
	roleIds: number[],
	gain: number,
	relative: boolean,
): Promise<void> {
	const url = `http://${instance.config.host}/api/2/keysets`
	const body: Record<string, unknown> = {}

	for (const roleId of roleIds) {
		const roleset = instance.rolesets.get(roleId)
		if (!roleset) {
			instance.log('warn', `setInputGain: no roleset found for role ${roleId}`)
			continue
		}
		const keysetId = roleset.sessions?.['B.FSII']?.data?.settings?.['defaultRole'] as number | undefined
		if (keysetId === undefined) {
			instance.log('warn', `setInputGain: no defaultRole found for role ${roleId}`)
			continue
		}

		let value = gain
		if (relative) {
			const current = instance.keysets.get(keysetId)
			if (!current) {
				instance.log('warn', `setInputGain: no cached keyset found for keysetId ${keysetId}`)
				continue
			}
			value = Math.min(15, Math.max(-70, (current.settings.portInputGain ?? 0) + gain))
		}

		body[String(keysetId)] = { type: 'FSII-BP', settings: { portInputGain: value } }
	}

	if (Object.keys(body).length === 0) return

	try {
		const response = await putRequest<{ ok: boolean; message: string }>(url, instance, body)
		instance.log('info', `setInputGain: ${JSON.stringify(response, null, 2)}`)
	} catch (error) {
		instance.log('error', `setInputGain failed: ${String(error)}`)
	}
}
