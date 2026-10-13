import {
  FlowCommandError,
  type FlowCommandGrant,
  type FlowCommandReceipt,
  type NodeExecuteCommand
} from '../../shared/agent-flow/commands'
import type { FlowCommandLedger } from './command-ledger'

export interface AgentToolPort {
  execute(command: NodeExecuteCommand, signal: AbortSignal): Promise<FlowCommandReceipt>
}

/** Uses the C2 ledger and desktop grant transport, never another business executor. */
export function createLedgerToolPort(
  ledger: FlowCommandLedger,
  deliver: (grant: FlowCommandGrant, signal: AbortSignal) => Promise<void>
): AgentToolPort {
  return {
    execute: async (command, signal) => {
      const lookup = { projectId: command.projectId, commandId: command.commandId }
      try {
        ledger.lookup(lookup)
        // Validate the intent even when a stable command ID already exists.
        const replay = ledger.prepare(command)
        if (replay.state === 'ready')
          throw new FlowCommandError('FLOW_RECEIPT_CONFLICT', 'receipt-read')
        return replay.receipt
      } catch (error) {
        if (!(error instanceof FlowCommandError) || error.code !== 'FLOW_COMMAND_MISSING')
          throw error
      }
      if (signal.aborted) throw new FlowCommandError('FLOW_CANCELLED', 'dispatch')
      const result = ledger.prepare(command)
      if (result.state !== 'ready') return result.receipt
      try {
        await deliver(result.grant, signal)
        return ledger.commit(lookup)
      } catch {
        // The grant may already have caused an effect. Preserve occupancy; do not resend.
        return ledger.unknown({ ...lookup, leaseId: result.grant.leaseId })
      }
    }
  }
}
