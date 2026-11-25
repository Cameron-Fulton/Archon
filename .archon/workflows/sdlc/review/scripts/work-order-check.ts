/**
 * Preflight check for review runs in work-order mode.
 *
 * Runs before `scope` (an LLM node) so an empty `work_order` is refused before any
 * model runs or reads PR text, even when the checkout head does not match the PR head.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_WORK_ORDER: the pinned work order text.
 * - INPUTS_WORK_ORDER_MODE: "true" when work-order mode is enabled by input.
 */

import { refuse, trimmed } from '../../.shared/io.ts';
import { isWorkOrderMode } from '../../.shared/work-order.ts';

try {
  if (isWorkOrderMode(process.env.INPUTS_WORK_ORDER_MODE) && trimmed(process.env.INPUTS_WORK_ORDER) === '') {
    throw new Error('work-order mode requires a non-empty work_order input');
  }
} catch (error) {
  refuse(`review work-order-check: ${error instanceof Error ? error.message : String(error)}`);
}
