/** Privileged worker access to bound residency. Callers must keep these
 * arrays private and read-only; result materializers return separate buffers.
 * Public copy-first binding remains on the main analysis surface. */
export { internalShardOf, internalTextOf } from './ops/binding.ts';
