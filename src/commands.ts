import ModuleInstance from './main.js'
import { ControlDef } from './types.js'
import { connectSocket, disconnectSocket } from './network.js'

export function connect(instance: ModuleInstance): void {
	connectSocket(instance)
}

export function disconnect(): void {
	disconnectSocket()
}

export const SKIP_PORT_SETTINGS = new Set([
	'vox',
	'networkQuality',
	'serial',
	'gpis',
	'gpos',
	'ivcDirect',
	'authentication',
	'associatedEndpoint',
])

export const SKIP_KEYSET_SETTINGS = new Set([
	'keysets',
	'groups',
	'gpios',
	'pgmAssignments',
	'saConnectionAssignments',
	'logicInput1ActionDestination',
	'logicInput2ActionDestination',
])

export const SKIP_LIVE_STATUS = new Set([
	'role',
	'session',
	'syncState',
	'antennaIndex',
	'antennaSlot',
	'frequencyType',
	'wirelessStatus',
])

const EXCLUDE_IDS = new Set<string>([])

const INCLUDE_ONLY_IDS = new Set<string>([])

export function filterControlDefs(defs: ControlDef[]): ControlDef[] {
	return defs.filter((def) => {
		if (EXCLUDE_IDS.has(def.id)) return false
		if (INCLUDE_ONLY_IDS.size > 0 && !INCLUDE_ONLY_IDS.has(def.id)) return false
		return true
	})
}
