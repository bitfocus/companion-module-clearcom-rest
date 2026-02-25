import { CompanionActionDefinitions, CompanionActionEvent } from '@companion-module/base'
import ModuleInstance from './main.js'
import * as arcadia from './arcadia.js'

export function UpdateActions(instance: ModuleInstance): void {
	const roleChoices = [...instance.rolesets.values()].map((rs) => ({
		id: String(rs.id),
		label: rs.name,
	}))

	const actions: CompanionActionDefinitions = {
		remote_mic_kill: {
			name: 'Remote Mic Kill (RMK)',
			options: [
				{
					type: 'multidropdown',
					label: 'Beltpack',
					id: 'roleIds',
					default: [],
					choices: [{ id: '', label: 'All' }, ...roleChoices],
				},
			],
			callback: async (action: CompanionActionEvent) => {
				const selected = action.options.roleIds as string[]
				for (const id of selected) {
					await arcadia.remoteMicKill(instance, id)
				}
			},
		},
		set_input_gain: {
			name: 'Set Input Gain',
			options: [
				{
					type: 'multidropdown',
					label: 'Beltpack',
					id: 'roleIds',
					default: [],
					choices: roleChoices,
				},
				{
					type: 'number',
					label: 'Gain (dB)',
					id: 'gain',
					default: 0,
					min: -70,
					max: 15,
				},
				{
					type: 'checkbox',
					label: 'Relative',
					id: 'relative',
					default: false,
				},
			],
			callback: async (action: CompanionActionEvent) => {
				const roleIds = (action.options.roleIds as string[]).map(Number)
				const gain = action.options.gain as number
				const relative = action.options.relative as boolean
				await arcadia.setInputGain(instance, roleIds, gain, relative)
			},
		},
	}

	instance.setActionDefinitions(actions)
}
