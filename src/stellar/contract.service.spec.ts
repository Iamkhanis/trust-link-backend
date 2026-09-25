import { Account } from '@stellar/stellar-sdk';
import { ContractService } from './contract.service';
import { ContractCallFailedException } from './contract-call-failed.exception';
import { DEFAULT_AUTO_RELEASE_MAX_RETRIES } from './contract.constants';

// Minimal StellarServer stub — jest.fn() so each test controls its behaviour.
function makeServer() {
  return {
    loadAccount: jest.fn<Promise<{ sequence: string }>, [string]>(),
    submitTransaction: jest.fn<
      Promise<{ hash?: string; status?: string; resultXdr?: string }>,
      [Record<string, unknown>]
    >(),
  };
}

const SOURCE = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
// The contract addresses escrows by its own u64, not the backend UUID.
const ESCROW = 42n;
const ADMIN = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

describe('ContractService', () => {
  describe('submitAutoRelease — happy path', () => {
    it('returns the transaction hash on first attempt', async () => {
      const server = makeServer();
      server.loadAccount.mockResolvedValue({ sequence: '100' });
      server.submitTransaction.mockResolvedValue({ hash: 'tx-hash-1' });

      const svc = new ContractService(server);
      const hash = await svc.submitAutoRelease(ESCROW, SOURCE);

      expect(hash).toBe('tx-hash-1');
      expect(server.loadAccount).toHaveBeenCalledTimes(1);
      expect(server.loadAccount).toHaveBeenCalledWith(SOURCE);
    });

    it('re-fetches the account on every attempt (not just once)', async () => {
      const server = makeServer();
      // First two loadAccount calls return stale sequence; third returns fresh.
      server.loadAccount
        .mockResolvedValueOnce({ sequence: '99' })
        .mockResolvedValueOnce({ sequence: '100' })
        .mockResolvedValueOnce({ sequence: '101' });

      // First two submits fail with a sequence error; third succeeds.
      server.submitTransaction
        .mockRejectedValueOnce(new Error('tx_bad_seq'))
        .mockRejectedValueOnce(new Error('tx_bad_seq'))
        .mockResolvedValueOnce({ hash: 'tx-hash-ok' });

      const svc = new ContractService(server);
      const hash = await svc.submitAutoRelease(ESCROW, SOURCE, 2);

      expect(hash).toBe('tx-hash-ok');
      // loadAccount must be called once per attempt, not once total.
      expect(server.loadAccount).toHaveBeenCalledTimes(3);
    });
  });

  describe('submitAutoRelease — sequence error retries', () => {
    it('retries up to maxRetries on tx_bad_seq then throws', async () => {
      const server = makeServer();
      server.loadAccount.mockResolvedValue({ sequence: '1' });
      server.submitTransaction.mockRejectedValue(new Error('tx_bad_seq'));

      const svc = new ContractService(server);

      await expect(
        svc.submitAutoRelease(ESCROW, SOURCE, DEFAULT_AUTO_RELEASE_MAX_RETRIES),
      ).rejects.toThrow('Max retries exceeded');

      // 1 initial attempt + DEFAULT_AUTO_RELEASE_MAX_RETRIES retries
      expect(server.loadAccount).toHaveBeenCalledTimes(
        1 + DEFAULT_AUTO_RELEASE_MAX_RETRIES,
      );
    });

    it('retries exactly maxRetries times before throwing Max retries exceeded', async () => {
      const server = makeServer();
      server.loadAccount.mockResolvedValue({ sequence: '1' });
      server.submitTransaction.mockRejectedValue(
        new Error('sequence number mismatch'),
      );

      const svc = new ContractService(server);
      const maxRetries = 1;

      await expect(
        svc.submitAutoRelease(ESCROW, SOURCE, maxRetries),
      ).rejects.toThrow('Max retries exceeded');

      expect(server.loadAccount).toHaveBeenCalledTimes(1 + maxRetries);
    });

    it('succeeds on final retry if submit eventually succeeds', async () => {
      const server = makeServer();
      server.loadAccount.mockResolvedValue({ sequence: '5' });
      server.submitTransaction
        .mockRejectedValueOnce(new Error('tx_bad_seq'))
        .mockResolvedValueOnce({ hash: 'tx-retry-ok' });

      const svc = new ContractService(server);
      const hash = await svc.submitAutoRelease(ESCROW, SOURCE, 1);

      expect(hash).toBe('tx-retry-ok');
      expect(server.loadAccount).toHaveBeenCalledTimes(2);
    });
  });

  describe('submitAutoRelease — non-sequence errors', () => {
    it('wraps non-sequence errors in ContractCallFailedException without retrying', async () => {
      const server = makeServer();
      server.loadAccount.mockResolvedValue({ sequence: '1' });
      server.submitTransaction.mockRejectedValue(
        new Error('connection refused'),
      );

      const svc = new ContractService(server);

      await expect(
        svc.submitAutoRelease(ESCROW, SOURCE),
      ).rejects.toBeInstanceOf(ContractCallFailedException);

      // No retries — loadAccount called once only
      expect(server.loadAccount).toHaveBeenCalledTimes(1);
    });

    it('re-throws ContractCallFailedException immediately without retrying', async () => {
      const server = makeServer();
      server.loadAccount.mockResolvedValue({ sequence: '1' });
      server.submitTransaction.mockResolvedValue({ status: 'ERROR' });

      const svc = new ContractService(server);

      await expect(
        svc.submitAutoRelease(ESCROW, SOURCE),
      ).rejects.toBeInstanceOf(ContractCallFailedException);

      expect(server.loadAccount).toHaveBeenCalledTimes(1);
    });

    it('throws ContractCallFailedException when hash is missing', async () => {
      const server = makeServer();
      server.loadAccount.mockResolvedValue({ sequence: '1' });
      server.submitTransaction.mockResolvedValue({ status: 'OK' }); // no hash

      const svc = new ContractService(server);

      await expect(svc.submitAutoRelease(ESCROW, SOURCE)).rejects.toThrow(
        'Missing transaction hash',
      );
    });
  });

  describe('submitAutoRelease — no server configured', () => {
    it('throws ContractCallFailedException when server is not injected', async () => {
      const svc = new ContractService(undefined);

      await expect(svc.submitAutoRelease(ESCROW, SOURCE)).rejects.toThrow(
        'Stellar server is not configured',
      );
    });
  });

  describe('resolveDispute', () => {
    it('returns the hash on success', async () => {
      const server = makeServer();
      server.submitTransaction.mockResolvedValue({ hash: 'dispute-hash' });

      const svc = new ContractService(server);
      const hash = await svc.resolveDispute(ESCROW, 'RELEASE', ADMIN);

      expect(hash).toBe('dispute-hash');
    });

    it('throws when status is ERROR', async () => {
      const server = makeServer();
      server.submitTransaction.mockResolvedValue({ status: 'ERROR' });

      const svc = new ContractService(server);
      await expect(
        svc.resolveDispute(ESCROW, 'REFUND', ADMIN),
      ).rejects.toBeInstanceOf(ContractCallFailedException);
    });

    it('throws when hash is missing', async () => {
      const server = makeServer();
      server.submitTransaction.mockResolvedValue({});

      const svc = new ContractService(server);
      await expect(
        svc.resolveDispute(ESCROW, 'RELEASE', ADMIN),
      ).rejects.toThrow('Missing transaction hash');
    });
  });

  describe('getEscrowState', () => {
    it('returns UNKNOWN and exists=false when server is not configured', async () => {
      const svc = new ContractService(undefined);
      const result = await svc.getEscrowState(ESCROW);
      expect(result).toEqual({ state: 'UNKNOWN', exists: false });
    });

    it('returns UNKNOWN and exists=false when submitTransaction throws', async () => {
      const server = makeServer();
      server.submitTransaction.mockRejectedValue(new Error('network error'));

      const svc = new ContractService(server);
      const result = await svc.getEscrowState(ESCROW);
      expect(result).toEqual({ state: 'UNKNOWN', exists: false });
    });

    it('returns UNKNOWN and exists=false when status is ERROR', async () => {
      const server = makeServer();
      server.submitTransaction.mockResolvedValue({ status: 'ERROR' });

      const svc = new ContractService(server);
      const result = await svc.getEscrowState(ESCROW);
      expect(result).toEqual({ state: 'UNKNOWN', exists: false });
    });

    it('returns resultXdr as state and exists=true on success', async () => {
      const server = makeServer();
      server.submitTransaction.mockResolvedValue({
        status: 'OK',
        resultXdr: 'FUNDED',
      });

      const svc = new ContractService(server);
      const result = await svc.getEscrowState(ESCROW);
      expect(result).toEqual({ state: 'FUNDED', exists: true });
    });
  });

  describe('cancelEscrowOnChain', () => {
    it('returns the hash on success', async () => {
      const server = makeServer();
      server.submitTransaction.mockResolvedValue({ hash: 'cancel-hash' });

      const svc = new ContractService(server);
      expect(await svc.cancelEscrowOnChain(ESCROW, ADMIN)).toBe('cancel-hash');
    });

    it('throws when server is not configured', async () => {
      const svc = new ContractService(undefined);
      await expect(svc.cancelEscrowOnChain(ESCROW, ADMIN)).rejects.toThrow(
        'Stellar server is not configured',
      );
    });

    it('throws ContractCallFailedException when resultXdr is TxFailed', async () => {
      const server = makeServer();
      server.submitTransaction.mockResolvedValue({ resultXdr: 'TxFailed' });

      const svc = new ContractService(server);
      await expect(
        svc.cancelEscrowOnChain(ESCROW, ADMIN),
      ).rejects.toBeInstanceOf(ContractCallFailedException);
    });
  });

  describe('recordDelivery', () => {
    it('returns the hash on success', async () => {
      const server = makeServer();
      server.submitTransaction.mockResolvedValue({ hash: 'delivery-hash' });

      const svc = new ContractService(server);
      expect(await svc.recordDelivery(ESCROW, ADMIN)).toBe('delivery-hash');
    });

    it('throws when server is not configured', async () => {
      const svc = new ContractService(undefined);
      await expect(svc.recordDelivery(ESCROW, ADMIN)).rejects.toThrow(
        'Stellar server is not configured',
      );
    });
  });

  describe('Soroban RPC lifecycle (Issue #478)', () => {
    function makeSorobanRpcServer() {
      return {
        getAccount: jest.fn().mockResolvedValue({
          sequenceNumber: () => '10',
          accountId: () => SOURCE,
        }),
        simulateTransaction: jest
          .fn()
          .mockResolvedValue({ transactionData: {} }),
        prepareTransaction: jest
          .fn()
          .mockImplementation((tx) => Promise.resolve(tx)),
        sendTransaction: jest.fn().mockResolvedValue({
          status: 'PENDING',
          hash: 'soroban-hash-1',
        }),
        getTransaction: jest.fn().mockResolvedValue({ status: 'SUCCESS' }),
        pollTransaction: jest.fn().mockResolvedValue({ status: 'SUCCESS' }),
      };
    }

    it('executes successful Soroban contract invocation flow', async () => {
      const server = makeSorobanRpcServer();
      const svc = new ContractService(server);

      const disputeHash = await svc.resolveDispute(ESCROW, 'RELEASE', ADMIN);
      expect(disputeHash).toBe('soroban-hash-1');
      expect(server.getAccount).toHaveBeenCalledWith(SOURCE);
      expect(server.simulateTransaction).toHaveBeenCalled();
      expect(server.prepareTransaction).toHaveBeenCalled();
      expect(server.sendTransaction).toHaveBeenCalled();
      expect(server.pollTransaction).toHaveBeenCalledWith('soroban-hash-1');

      const releaseHash = await svc.submitAutoRelease(ESCROW, SOURCE);
      expect(releaseHash).toBe('soroban-hash-1');

      const cancelHash = await svc.cancelEscrowOnChain(ESCROW, ADMIN);
      expect(cancelHash).toBe('soroban-hash-1');

      const deliveryHash = await svc.recordDelivery(ESCROW, ADMIN);
      expect(deliveryHash).toBe('soroban-hash-1');
    });

    it('handles simulation failure', async () => {
      const server = makeSorobanRpcServer();
      server.simulateTransaction.mockResolvedValue({
        error: 'Host error: ContractError(101)',
      });

      const svc = new ContractService(server);
      await expect(
        svc.resolveDispute(ESCROW, 'RELEASE', ADMIN),
      ).rejects.toThrow(ContractCallFailedException);
    });

    it('handles transaction preparation failure', async () => {
      const server = makeSorobanRpcServer();
      server.prepareTransaction.mockRejectedValue(
        new Error('Resource limits exceeded'),
      );

      const svc = new ContractService(server);
      await expect(
        svc.resolveDispute(ESCROW, 'RELEASE', ADMIN),
      ).rejects.toThrow(ContractCallFailedException);
    });

    it('handles submission error status', async () => {
      const server = makeSorobanRpcServer();
      server.sendTransaction.mockResolvedValue({
        status: 'ERROR',
        errorResultXdr: 'tx_failed',
      });

      const svc = new ContractService(server);
      await expect(
        svc.resolveDispute(ESCROW, 'RELEASE', ADMIN),
      ).rejects.toThrow(ContractCallFailedException);
    });

    it('handles polling failure and decodes contract error', async () => {
      const server = makeSorobanRpcServer();
      server.sendTransaction.mockResolvedValue({
        status: 'PENDING',
        hash: 'soroban-hash-poll-fail',
      });
      server.pollTransaction.mockResolvedValue({
        status: 'FAILED',
        resultXdr: 'Error(Contract, #404)',
      });

      const svc = new ContractService(server);
      await expect(
        svc.resolveDispute(ESCROW, 'RELEASE', ADMIN),
      ).rejects.toThrow(ContractCallFailedException);
    });

    it('retries on sequence error and re-fetches account on each attempt', async () => {
      const server = makeSorobanRpcServer();
      server.sendTransaction
        .mockResolvedValueOnce({
          status: 'ERROR',
          errorResultXdr: 'tx_bad_seq',
        })
        .mockResolvedValueOnce({
          status: 'PENDING',
          hash: 'soroban-retry-success-hash',
        });

      const svc = new ContractService(server);
      const hash = await svc.submitAutoRelease(ESCROW, SOURCE, 2);

      expect(hash).toBe('soroban-retry-success-hash');
      expect(server.getAccount).toHaveBeenCalledTimes(2);
    });

    it('simulates getEscrowState with Soroban RPC', async () => {
      const server = makeSorobanRpcServer();
      const svc = new ContractService(server);

      const resultOk = await svc.getEscrowState(ESCROW);
      expect(resultOk).toEqual({ state: 'CREATED', exists: true });

      server.simulateTransaction.mockResolvedValue({
        error: 'Contract error',
      });
      const resultFail = await svc.getEscrowState(ESCROW);
      expect(resultFail).toEqual({ state: 'UNKNOWN', exists: false });
    });

    it('fetchAccount returns the SDK Account instance directly when getAccount does', async () => {
      const server = makeSorobanRpcServer();
      const realAccount = new Account(SOURCE, '55');
      server.getAccount.mockResolvedValue(realAccount);

      const svc = new ContractService(server);
      const hash = await svc.resolveDispute(ESCROW, 'RELEASE', ADMIN);

      expect(hash).toBe('soroban-hash-1');
    });

    it('falls back to getTransaction when the server has no pollTransaction', async () => {
      const server = makeSorobanRpcServer();
      // @ts-expect-error — exercising the pollTransactionStatus fallback path
      delete server.pollTransaction;
      server.getTransaction.mockResolvedValue({ status: 'SUCCESS' });

      const svc = new ContractService(server);
      const hash = await svc.resolveDispute(ESCROW, 'RELEASE', ADMIN);

      expect(hash).toBe('soroban-hash-1');
      expect(server.getTransaction).toHaveBeenCalledWith('soroban-hash-1');
    });
  });

  describe('submitAutoRelease — invalid maxRetries', () => {
    it('throws immediately without any network call when maxRetries is negative', async () => {
      const server = makeServer();
      const svc = new ContractService(server);

      await expect(svc.submitAutoRelease(ESCROW, SOURCE, -1)).rejects.toThrow(
        'Max retries exceeded',
      );
      expect(server.loadAccount).not.toHaveBeenCalled();
    });
  });

  describe('Degraded RPC conditions — all 26 uncovered branches', () => {
    describe('Missing or partial server methods', () => {
      it('throws when simulateTransaction is missing', async () => {
        const server = {
          getAccount: jest.fn().mockResolvedValue({ sequenceNumber: () => '10' }),
          prepareTransaction: jest.fn(),
          sendTransaction: jest.fn(),
          pollTransaction: jest.fn(),
        };

        const svc = new ContractService(server);
        await expect(
          svc.resolveDispute(ESCROW, 'RELEASE', ADMIN),
        ).rejects.toThrow('simulateTransaction is not supported');
      });

      it('throws when sendTransaction is missing', async () => {
        const server = {
          getAccount: jest.fn().mockResolvedValue({ sequenceNumber: () => '10' }),
          simulateTransaction: jest
            .fn()
            .mockResolvedValue({ transactionData: {} }),
          prepareTransaction: jest.fn().mockImplementation((tx) =>
            Promise.resolve(tx),
          ),
          pollTransaction: jest.fn(),
        };

        const svc = new ContractService(server);
        await expect(
          svc.resolveDispute(ESCROW, 'RELEASE', ADMIN),
        ).rejects.toThrow('sendTransaction is not supported');
      });

      it('throws when neither loadAccount nor getAccount exists', async () => {
        const server = {
          simulateTransaction: jest
            .fn()
            .mockResolvedValue({ transactionData: {} }),
          prepareTransaction: jest.fn().mockImplementation((tx) =>
            Promise.resolve(tx),
          ),
          sendTransaction: jest.fn().mockResolvedValue({
            status: 'PENDING',
            hash: 'tx-hash',
          }),
          pollTransaction: jest.fn().mockResolvedValue({ status: 'SUCCESS' }),
        };

        const svc = new ContractService(server);
        const hash = await svc.resolveDispute(ESCROW, 'RELEASE', ADMIN);
        expect(hash).toBe('tx-hash');
      });
    });

    describe('Server method type guards in invokeContract', () => {
      it('uses legacy submitTransaction path when simulateTransaction is missing', async () => {
        const server = {
          submitTransaction: jest.fn().mockResolvedValue({
            hash: 'legacy-hash',
            status: 'OK',
          }),
          loadAccount: jest.fn().mockResolvedValue({ sequence: '5' }),
        };

        const svc = new ContractService(server);
        const hash = await svc.submitAutoRelease(ESCROW, SOURCE);

        expect(hash).toBe('legacy-hash');
        expect(server.submitTransaction).toHaveBeenCalled();
      });

      it('maps functionName to operation name in legacy path', async () => {
        const server = {
          submitTransaction: jest.fn().mockResolvedValue({
            hash: 'tx1',
            status: 'OK',
          }),
          loadAccount: jest.fn().mockResolvedValue({ sequence: '1' }),
        };

        const svc = new ContractService(server);
        await svc.resolveDispute(ESCROW, 'RELEASE', ADMIN);

        const call = server.submitTransaction.mock.calls[0][0];
        expect(call.operation).toBe('resolveDispute');
      });

      it('handles legacy path for cancel_escrow operation', async () => {
        const server = {
          submitTransaction: jest.fn().mockResolvedValue({
            hash: 'cancel-tx',
            status: 'OK',
          }),
        };

        const svc = new ContractService(server);
        await svc.cancelEscrowOnChain(ESCROW, ADMIN);

        const call = server.submitTransaction.mock.calls[0][0];
        expect(call.operation).toBe('cancelEscrow');
      });

      it('handles legacy path for record_delivery operation', async () => {
        const server = {
          submitTransaction: jest.fn().mockResolvedValue({
            hash: 'delivery-tx',
            status: 'OK',
          }),
        };

        const svc = new ContractService(server);
        await svc.recordDelivery(ESCROW, ADMIN);

        const call = server.submitTransaction.mock.calls[0][0];
        expect(call.operation).toBe('recordDelivery');
      });

      it('includes sequence in legacy submitTransaction when auto_release', async () => {
        const server = {
          submitTransaction: jest.fn().mockResolvedValue({
            hash: 'tx-seq',
            status: 'OK',
          }),
          loadAccount: jest.fn().mockResolvedValue({ sequence: '42' }),
        };

        const svc = new ContractService(server);
        await svc.submitAutoRelease(ESCROW, SOURCE);

        const call = server.submitTransaction.mock.calls[0][0];
        expect(call.sequence).toBe('42');
      });

      it('throws when legacy path has ERROR status', async () => {
        const server = {
          submitTransaction: jest.fn().mockResolvedValue({
            status: 'ERROR',
            resultXdr: 'error_details',
          }),
          loadAccount: jest.fn().mockResolvedValue({ sequence: '1' }),
        };

        const svc = new ContractService(server);
        await expect(
          svc.submitAutoRelease(ESCROW, SOURCE),
        ).rejects.toBeInstanceOf(ContractCallFailedException);
      });

      it('throws when legacy path has TxFailed resultXdr', async () => {
        const server = {
          submitTransaction: jest.fn().mockResolvedValue({
            status: 'OK',
            resultXdr: 'TxFailed',
          }),
          loadAccount: jest.fn().mockResolvedValue({ sequence: '1' }),
        };

        const svc = new ContractService(server);
        await expect(
          svc.submitAutoRelease(ESCROW, SOURCE),
        ).rejects.toBeInstanceOf(ContractCallFailedException);
      });
    });

    describe('Simulation error handling', () => {
      it('detects isSimulationError via rpc.Api.isSimulationError', async () => {
        const server = {
          getAccount: jest.fn().mockResolvedValue({ sequenceNumber: () => '10' }),
          simulateTransaction: jest.fn().mockResolvedValue({
            error: 'Host error from SDK check',
          }),
          prepareTransaction: jest.fn(),
          sendTransaction: jest.fn(),
          pollTransaction: jest.fn(),
        };

        const svc = new ContractService(server);
        await expect(
          svc.resolveDispute(ESCROW, 'RELEASE', ADMIN),
        ).rejects.toThrow('Simulation failed');
      });

      it('handles simulation error with no error message', async () => {
        const server = {
          getAccount: jest.fn().mockResolvedValue({ sequenceNumber: () => '10' }),
          simulateTransaction: jest.fn().mockResolvedValue({
            // Has error but returns empty string
          }),
          prepareTransaction: jest.fn(),
          sendTransaction: jest.fn(),
          pollTransaction: jest.fn(),
        };

        const svc = new ContractService(server);
        await expect(
          svc.resolveDispute(ESCROW, 'RELEASE', ADMIN),
        ).rejects.toThrow('Unknown simulation error');
      });

      it('returns UNKNOWN state in getEscrowState when simulateTransaction has error', async () => {
        const server = {
          simulateTransaction: jest.fn().mockResolvedValue({
            error: 'Contract simulation failed',
          }),
        };

        const svc = new ContractService(server);
        const result = await svc.getEscrowState(ESCROW);
        expect(result).toEqual({ state: 'UNKNOWN', exists: false });
      });
    });

    describe('Transaction submission error handling', () => {
      it('throws when sendTransaction returns ERROR status with errorResultXdr', async () => {
        const server = {
          getAccount: jest.fn().mockResolvedValue({ sequenceNumber: () => '10' }),
          simulateTransaction: jest
            .fn()
            .mockResolvedValue({ transactionData: {} }),
          prepareTransaction: jest.fn().mockImplementation((tx) =>
            Promise.resolve(tx),
          ),
          sendTransaction: jest.fn().mockResolvedValue({
            status: 'ERROR',
            errorResultXdr: 'detailed_error_xdr',
          }),
        };

        const svc = new ContractService(server);
        await expect(
          svc.resolveDispute(ESCROW, 'RELEASE', ADMIN),
        ).rejects.toThrow('Submission failed');
      });

      it('throws when sendTransaction returns ERROR status with errorResult fallback', async () => {
        const server = {
          getAccount: jest.fn().mockResolvedValue({ sequenceNumber: () => '10' }),
          simulateTransaction: jest
            .fn()
            .mockResolvedValue({ transactionData: {} }),
          prepareTransaction: jest.fn().mockImplementation((tx) =>
            Promise.resolve(tx),
          ),
          sendTransaction: jest.fn().mockResolvedValue({
            status: 'ERROR',
            errorResult: 'old_sdk_format_error',
          }),
        };

        const svc = new ContractService(server);
        await expect(
          svc.resolveDispute(ESCROW, 'RELEASE', ADMIN),
        ).rejects.toThrow('Submission failed');
      });

      it('throws when sendTransaction returns ERROR with no error details', async () => {
        const server = {
          getAccount: jest.fn().mockResolvedValue({ sequenceNumber: () => '10' }),
          simulateTransaction: jest
            .fn()
            .mockResolvedValue({ transactionData: {} }),
          prepareTransaction: jest.fn().mockImplementation((tx) =>
            Promise.resolve(tx),
          ),
          sendTransaction: jest.fn().mockResolvedValue({
            status: 'ERROR',
          }),
        };

        const svc = new ContractService(server);
        await expect(
          svc.resolveDispute(ESCROW, 'RELEASE', ADMIN),
        ).rejects.toThrow('Transaction submission returned ERROR status');
      });

      it('detects sequence error in errorResultXdr and retries', async () => {
        const server = {
          getAccount: jest
            .fn()
            .mockResolvedValueOnce({ sequenceNumber: () => '1' })
            .mockResolvedValueOnce({ sequenceNumber: () => '2' }),
          simulateTransaction: jest
            .fn()
            .mockResolvedValue({ transactionData: {} }),
          prepareTransaction: jest.fn().mockImplementation((tx) =>
            Promise.resolve(tx),
          ),
          sendTransaction: jest
            .fn()
            .mockResolvedValueOnce({
              status: 'ERROR',
              errorResultXdr: 'tx_bad_seq error',
            })
            .mockResolvedValueOnce({
              status: 'PENDING',
              hash: 'retry-success',
            }),
          pollTransaction: jest.fn().mockResolvedValue({ status: 'SUCCESS' }),
        };

        const svc = new ContractService(server);
        const hash = await svc.submitAutoRelease(ESCROW, SOURCE, 2);
        expect(hash).toBe('retry-success');
      });

      it('throws when sendTransaction returns ERROR with json stringified error', async () => {
        const server = {
          getAccount: jest.fn().mockResolvedValue({ sequenceNumber: () => '10' }),
          simulateTransaction: jest
            .fn()
            .mockResolvedValue({ transactionData: {} }),
          prepareTransaction: jest.fn().mockImplementation((tx) =>
            Promise.resolve(tx),
          ),
          sendTransaction: jest.fn().mockResolvedValue({
            status: 'ERROR',
            errorResultXdr: { type: 'TxFailed', code: 1 },
          }),
        };

        const svc = new ContractService(server);
        await expect(
          svc.resolveDispute(ESCROW, 'RELEASE', ADMIN),
        ).rejects.toThrow('Submission failed');
      });

      it('throws when sendTransaction does not return a hash', async () => {
        const server = {
          getAccount: jest.fn().mockResolvedValue({ sequenceNumber: () => '10' }),
          simulateTransaction: jest
            .fn()
            .mockResolvedValue({ transactionData: {} }),
          prepareTransaction: jest.fn().mockImplementation((tx) =>
            Promise.resolve(tx),
          ),
          sendTransaction: jest.fn().mockResolvedValue({
            status: 'PENDING',
          }),
        };

        const svc = new ContractService(server);
        await expect(
          svc.resolveDispute(ESCROW, 'RELEASE', ADMIN),
        ).rejects.toThrow('Missing transaction hash');
      });
    });

    describe('Transaction polling and status handling', () => {
      it('handles NOT_FOUND status from getTransaction', async () => {
        const server = {
          getAccount: jest.fn().mockResolvedValue({ sequenceNumber: () => '10' }),
          simulateTransaction: jest
            .fn()
            .mockResolvedValue({ transactionData: {} }),
          prepareTransaction: jest.fn().mockImplementation((tx) =>
            Promise.resolve(tx),
          ),
          sendTransaction: jest.fn().mockResolvedValue({
            status: 'PENDING',
            hash: 'pending-hash',
          }),
          getTransaction: jest.fn().mockResolvedValue({
            status: 'NOT_FOUND',
          }),
        };

        const svc = new ContractService(server);
        // Polling returns NOT_FOUND, but we don't retry further, just return
        await expect(
          svc.resolveDispute(ESCROW, 'RELEASE', ADMIN),
        ).rejects.toThrow(ContractCallFailedException);
      });

      it('handles PENDING status from getTransaction', async () => {
        const server = {
          getAccount: jest.fn().mockResolvedValue({ sequenceNumber: () => '10' }),
          simulateTransaction: jest
            .fn()
            .mockResolvedValue({ transactionData: {} }),
          prepareTransaction: jest.fn().mockImplementation((tx) =>
            Promise.resolve(tx),
          ),
          sendTransaction: jest.fn().mockResolvedValue({
            status: 'PENDING',
            hash: 'pending-hash',
          }),
          getTransaction: jest.fn().mockResolvedValue({
            status: 'PENDING',
          }),
        };

        const svc = new ContractService(server);
        await expect(
          svc.resolveDispute(ESCROW, 'RELEASE', ADMIN),
        ).rejects.toThrow(ContractCallFailedException);
      });

      it('uses default fallback when neither pollTransaction nor getTransaction exist', async () => {
        const server = {
          getAccount: jest.fn().mockResolvedValue({ sequenceNumber: () => '10' }),
          simulateTransaction: jest
            .fn()
            .mockResolvedValue({ transactionData: {} }),
          prepareTransaction: jest.fn().mockImplementation((tx) =>
            Promise.resolve(tx),
          ),
          sendTransaction: jest.fn().mockResolvedValue({
            status: 'PENDING',
            hash: 'fallback-hash',
          }),
          // No pollTransaction or getTransaction
        };

        const svc = new ContractService(server);
        const hash = await svc.resolveDispute(ESCROW, 'RELEASE', ADMIN);
        expect(hash).toBe('fallback-hash');
      });

      it('handles FAILED status with resultXdr decoding', async () => {
        const server = {
          getAccount: jest.fn().mockResolvedValue({ sequenceNumber: () => '10' }),
          simulateTransaction: jest
            .fn()
            .mockResolvedValue({ transactionData: {} }),
          prepareTransaction: jest.fn().mockImplementation((tx) =>
            Promise.resolve(tx),
          ),
          sendTransaction: jest.fn().mockResolvedValue({
            status: 'PENDING',
            hash: 'failed-hash',
          }),
          pollTransaction: jest.fn().mockResolvedValue({
            status: 'FAILED',
            resultXdr: 'ContractError(#42)',
          }),
        };

        const svc = new ContractService(server);
        await expect(
          svc.resolveDispute(ESCROW, 'RELEASE', ADMIN),
        ).rejects.toThrow('Contract execution failed: ContractError(#42)');
      });

      it('handles FAILED status with no resultXdr', async () => {
        const server = {
          getAccount: jest.fn().mockResolvedValue({ sequenceNumber: () => '10' }),
          simulateTransaction: jest
            .fn()
            .mockResolvedValue({ transactionData: {} }),
          prepareTransaction: jest.fn().mockImplementation((tx) =>
            Promise.resolve(tx),
          ),
          sendTransaction: jest.fn().mockResolvedValue({
            status: 'PENDING',
            hash: 'failed-hash-2',
          }),
          pollTransaction: jest.fn().mockResolvedValue({
            status: 'FAILED',
          }),
        };

        const svc = new ContractService(server);
        await expect(
          svc.resolveDispute(ESCROW, 'RELEASE', ADMIN),
        ).rejects.toThrow('Contract execution failed: Transaction failed on chain');
      });

      it('handles FAILED status with resultXdr as object (json stringified)', async () => {
        const server = {
          getAccount: jest.fn().mockResolvedValue({ sequenceNumber: () => '10' }),
          simulateTransaction: jest
            .fn()
            .mockResolvedValue({ transactionData: {} }),
          prepareTransaction: jest.fn().mockImplementation((tx) =>
            Promise.resolve(tx),
          ),
          sendTransaction: jest.fn().mockResolvedValue({
            status: 'PENDING',
            hash: 'failed-hash-3',
          }),
          pollTransaction: jest.fn().mockResolvedValue({
            status: 'FAILED',
            resultXdr: { code: 'TRANSACTION_FAILED', details: 'auth failed' },
          }),
        };

        const svc = new ContractService(server);
        await expect(
          svc.resolveDispute(ESCROW, 'RELEASE', ADMIN),
        ).rejects.toThrow('Contract execution failed');
      });
    });

    describe('Account fetching with different shapes', () => {
      it('fetchAccount returns Account instance directly', async () => {
        const realAccount = new Account(SOURCE, '99');
        const server = {
          getAccount: jest.fn().mockResolvedValue(realAccount),
          simulateTransaction: jest
            .fn()
            .mockResolvedValue({ transactionData: {} }),
          prepareTransaction: jest.fn().mockImplementation((tx) =>
            Promise.resolve(tx),
          ),
          sendTransaction: jest.fn().mockResolvedValue({
            status: 'PENDING',
            hash: 'acct-hash',
          }),
          pollTransaction: jest.fn().mockResolvedValue({ status: 'SUCCESS' }),
        };

        const svc = new ContractService(server);
        const hash = await svc.resolveDispute(ESCROW, 'RELEASE', ADMIN);
        expect(hash).toBe('acct-hash');
      });

      it('fetchAccount extracts sequence from Horizon-style account (sequenceNumber function)', async () => {
        const server = {
          getAccount: jest.fn().mockResolvedValue({
            sequenceNumber: () => '77',
            accountId: () => SOURCE,
          }),
          simulateTransaction: jest
            .fn()
            .mockResolvedValue({ transactionData: {} }),
          prepareTransaction: jest.fn().mockImplementation((tx) =>
            Promise.resolve(tx),
          ),
          sendTransaction: jest.fn().mockResolvedValue({
            status: 'PENDING',
            hash: 'horizon-hash',
          }),
          pollTransaction: jest.fn().mockResolvedValue({ status: 'SUCCESS' }),
        };

        const svc = new ContractService(server);
        const hash = await svc.resolveDispute(ESCROW, 'RELEASE', ADMIN);
        expect(hash).toBe('horizon-hash');
      });

      it('fetchAccount extracts sequence from string property', async () => {
        const server = {
          getAccount: jest.fn().mockResolvedValue({
            sequence: '88',
          }),
          simulateTransaction: jest
            .fn()
            .mockResolvedValue({ transactionData: {} }),
          prepareTransaction: jest.fn().mockImplementation((tx) =>
            Promise.resolve(tx),
          ),
          sendTransaction: jest.fn().mockResolvedValue({
            status: 'PENDING',
            hash: 'string-seq-hash',
          }),
          pollTransaction: jest.fn().mockResolvedValue({ status: 'SUCCESS' }),
        };

        const svc = new ContractService(server);
        const hash = await svc.resolveDispute(ESCROW, 'RELEASE', ADMIN);
        expect(hash).toBe('string-seq-hash');
      });

      it('fetchAccount extracts sequence from number property', async () => {
        const server = {
          getAccount: jest.fn().mockResolvedValue({
            sequence: 99,
          }),
          simulateTransaction: jest
            .fn()
            .mockResolvedValue({ transactionData: {} }),
          prepareTransaction: jest.fn().mockImplementation((tx) =>
            Promise.resolve(tx),
          ),
          sendTransaction: jest.fn().mockResolvedValue({
            status: 'PENDING',
            hash: 'number-seq-hash',
          }),
          pollTransaction: jest.fn().mockResolvedValue({ status: 'SUCCESS' }),
        };

        const svc = new ContractService(server);
        const hash = await svc.resolveDispute(ESCROW, 'RELEASE', ADMIN);
        expect(hash).toBe('number-seq-hash');
      });

      it('fetchAccount uses loadAccount as fallback when getAccount is missing', async () => {
        const server = {
          loadAccount: jest.fn().mockResolvedValue({ sequence: '55' }),
          simulateTransaction: jest
            .fn()
            .mockResolvedValue({ transactionData: {} }),
          prepareTransaction: jest.fn().mockImplementation((tx) =>
            Promise.resolve(tx),
          ),
          sendTransaction: jest.fn().mockResolvedValue({
            status: 'PENDING',
            hash: 'loadaccount-hash',
          }),
          pollTransaction: jest.fn().mockResolvedValue({ status: 'SUCCESS' }),
        };

        const svc = new ContractService(server);
        const hash = await svc.resolveDispute(ESCROW, 'RELEASE', ADMIN);
        expect(hash).toBe('loadaccount-hash');
      });

      it('fetchAccount returns default sequence when both getAccount and loadAccount are missing', async () => {
        const server = {
          simulateTransaction: jest
            .fn()
            .mockResolvedValue({ transactionData: {} }),
          prepareTransaction: jest.fn().mockImplementation((tx) =>
            Promise.resolve(tx),
          ),
          sendTransaction: jest.fn().mockResolvedValue({
            status: 'PENDING',
            hash: 'default-seq-hash',
          }),
          pollTransaction: jest.fn().mockResolvedValue({ status: 'SUCCESS' }),
        };

        const svc = new ContractService(server);
        const hash = await svc.resolveDispute(ESCROW, 'RELEASE', ADMIN);
        expect(hash).toBe('default-seq-hash');
      });
    });

    describe('isSequenceError detection', () => {
      it('detects sequence error from string message with "sequence" substring', async () => {
        const server = {
          loadAccount: jest.fn().mockResolvedValue({ sequence: '1' }),
          submitTransaction: jest.fn().mockRejectedValue(new Error('sequence number mismatch')),
        };

        const svc = new ContractService(server);
        await expect(
          svc.submitAutoRelease(ESCROW, SOURCE, 1),
        ).rejects.toThrow('Max retries exceeded');

        expect(server.loadAccount).toHaveBeenCalledTimes(2);
      });

      it('detects sequence error from Error instance message with "tx_bad_seq"', async () => {
        const server = {
          loadAccount: jest.fn().mockResolvedValue({ sequence: '1' }),
          submitTransaction: jest
            .fn()
            .mockRejectedValueOnce(new Error('tx_bad_seq from server'))
            .mockResolvedValueOnce({ hash: 'retry-hash' }),
        };

        const svc = new ContractService(server);
        const hash = await svc.submitAutoRelease(ESCROW, SOURCE, 1);
        expect(hash).toBe('retry-hash');
      });

      it('detects sequence error from Error instance message with "bad_seq"', async () => {
        const server = {
          loadAccount: jest.fn().mockResolvedValue({ sequence: '1' }),
          submitTransaction: jest
            .fn()
            .mockRejectedValueOnce(new Error('bad_seq encountered'))
            .mockResolvedValueOnce({ hash: 'retry-hash-2' }),
        };

        const svc = new ContractService(server);
        const hash = await svc.submitAutoRelease(ESCROW, SOURCE, 1);
        expect(hash).toBe('retry-hash-2');
      });

      it('does not retry when error is not a sequence error', async () => {
        const server = {
          loadAccount: jest.fn().mockResolvedValue({ sequence: '1' }),
          submitTransaction: jest
            .fn()
            .mockRejectedValue(new Error('connection timeout')),
        };

        const svc = new ContractService(server);
        await expect(
          svc.submitAutoRelease(ESCROW, SOURCE, 5),
        ).rejects.toBeInstanceOf(ContractCallFailedException);

        expect(server.loadAccount).toHaveBeenCalledTimes(1);
      });

      it('handles non-Error objects gracefully in isSequenceError', async () => {
        const server = {
          loadAccount: jest.fn().mockResolvedValue({ sequence: '1' }),
          submitTransaction: jest
            .fn()
            .mockRejectedValue('plain string error tx_bad_seq'),
        };

        const svc = new ContractService(server);
        const hash = await svc.submitAutoRelease(ESCROW, SOURCE, 1);
        expect(hash).toBeDefined();
      });
    });

    describe('Preparation error handling', () => {
      it('throws when prepareTransaction is missing but rpc.assembleTransaction also missing', async () => {
        const server = {
          getAccount: jest.fn().mockResolvedValue({ sequenceNumber: () => '10' }),
          simulateTransaction: jest
            .fn()
            .mockResolvedValue({ transactionData: {} }),
          sendTransaction: jest.fn(),
          pollTransaction: jest.fn(),
        };

        const svc = new ContractService(server);
        // prepareTransaction returns tx unmodified when missing, so we still proceed
        const hash = await svc.resolveDispute(ESCROW, 'RELEASE', ADMIN);
        expect(hash).toBeDefined();
      });

      it('throws ContractCallFailedException when prepareTransaction throws', async () => {
        const server = {
          getAccount: jest.fn().mockResolvedValue({ sequenceNumber: () => '10' }),
          simulateTransaction: jest
            .fn()
            .mockResolvedValue({ transactionData: {} }),
          prepareTransaction: jest
            .fn()
            .mockRejectedValue(new Error('Resource limit exceeded')),
          sendTransaction: jest.fn(),
          pollTransaction: jest.fn(),
        };

        const svc = new ContractService(server);
        await expect(
          svc.resolveDispute(ESCROW, 'RELEASE', ADMIN),
        ).rejects.toThrow('Transaction preparation failed');
      });

      it('wraps non-Error prepareTransaction exceptions in ContractCallFailedException', async () => {
        const server = {
          getAccount: jest.fn().mockResolvedValue({ sequenceNumber: () => '10' }),
          simulateTransaction: jest
            .fn()
            .mockResolvedValue({ transactionData: {} }),
          prepareTransaction: jest
            .fn()
            .mockRejectedValue('Unknown prep error'),
          sendTransaction: jest.fn(),
          pollTransaction: jest.fn(),
        };

        const svc = new ContractService(server);
        await expect(
          svc.resolveDispute(ESCROW, 'RELEASE', ADMIN),
        ).rejects.toThrow('Transaction preparation failed');
      });
    });

    describe('Invalid contract ID handling', () => {
      it('throws when contract ID is invalid', async () => {
        const config = {
          get: jest.fn((key) => {
            if (key === 'CONTRACT_ID') return 'NOT_A_VALID_CONTRACT_ID';
            if (key === 'STELLAR_NETWORK') return 'TESTNET';
            return undefined;
          }),
        };

        const server = {
          getAccount: jest.fn().mockResolvedValue({ sequenceNumber: () => '10' }),
          simulateTransaction: jest.fn(),
          prepareTransaction: jest.fn(),
          sendTransaction: jest.fn(),
          pollTransaction: jest.fn(),
        };

        const svc = new ContractService(server, config);
        await expect(
          svc.resolveDispute(ESCROW, 'RELEASE', ADMIN),
        ).rejects.toThrow('Invalid contract ID');
      });
    });

    describe('GetEscrowState with mixed server methods', () => {
      it('uses submitTransaction when available but simulateTransaction is missing', async () => {
        const server = {
          submitTransaction: jest.fn().mockResolvedValue({
            status: 'OK',
            resultXdr: 'RELEASED',
          }),
        };

        const svc = new ContractService(server);
        const result = await svc.getEscrowState(ESCROW);
        expect(result).toEqual({ state: 'RELEASED', exists: true });
      });

      it('returns default resultXdr when resultXdr is missing in successful submitTransaction', async () => {
        const server = {
          submitTransaction: jest.fn().mockResolvedValue({
            status: 'OK',
          }),
        };

        const svc = new ContractService(server);
        const result = await svc.getEscrowState(ESCROW);
        expect(result).toEqual({ state: 'CREATED', exists: true });
      });

      it('uses Soroban RPC path when simulateTransaction exists', async () => {
        const server = {
          simulateTransaction: jest
            .fn()
            .mockResolvedValue({ transactionData: {} }),
        };

        const svc = new ContractService(server);
        const result = await svc.getEscrowState(ESCROW);
        expect(result).toEqual({ state: 'CREATED', exists: true });
      });

      it('returns UNKNOWN when Soroban simulation throws', async () => {
        const server = {
          simulateTransaction: jest
            .fn()
            .mockRejectedValue(new Error('Network error')),
        };

        const svc = new ContractService(server);
        const result = await svc.getEscrowState(ESCROW);
        expect(result).toEqual({ state: 'UNKNOWN', exists: false });
      });
    });
  });
});
