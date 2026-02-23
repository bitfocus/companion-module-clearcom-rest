import { Regex, type SomeCompanionConfigField } from '@companion-module/base'

export type ModuleConfig = {
	host: string
	password: string
}

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
			type: 'textinput',
			id: 'password',
			label: 'Admin Password',
			width: 8,
		},
	]
}
