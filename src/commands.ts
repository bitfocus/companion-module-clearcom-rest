import ModuleInstance from './main.js'
import { ControlDef } from './types.js'
import { connectSocket, disconnectSocket } from './network.js'

// ─── Device dispatch ──────────────────────────────────────────────────────────
// All device-specific socket connect/disconnect goes through here.
// When freespeak.ts / edge.ts are added, switch on instance.config.deviceType
// and import the appropriate module's connect/disconnect instead.

export function connect(instance: ModuleInstance): void {
	connectSocket(instance)
}

export function disconnect(instance: ModuleInstance): void {
	disconnectSocket(instance)
}

// ─── Schema-level skip lists ─────────────────────────────────────────────────
// Raw property keys excluded during schema parsing, before ControlDef IDs exist.
// Add keys here to suppress entire categories of schema-derived fields.

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

// ─── ControlDef filter ────────────────────────────────────────────────────────
// Defs listed here are excluded from actions and feedbacks regardless of schema.
// Use this to suppress fields that are technically valid but not useful in
// Companion, or that cause problems on certain firmware versions.

const EXCLUDE_IDS = new Set<string>([
	// Examples (uncomment to activate):
	// 'port.splitLabel',       // internal field, not user-facing
	// 'port.isIVCPortEnabled', // IVC-only, irrelevant for most installs
])

// Defs listed here are the ONLY ones included (empty = no whitelist, include all).
// Useful during development to limit scope to a known-working subset.
const INCLUDE_ONLY_IDS = new Set<string>([
	// Leave empty for production — all non-excluded defs are included
])

export function filterControlDefs(defs: ControlDef[]): ControlDef[] {
	return defs.filter((def) => {
		if (EXCLUDE_IDS.has(def.id)) return false
		if (INCLUDE_ONLY_IDS.size > 0 && !INCLUDE_ONLY_IDS.has(def.id)) return false
		return true
	})
}
