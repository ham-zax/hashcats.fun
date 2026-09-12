# Native wallet workflow — Robinhood Wallet on iPhone

Decision recorded 2026-09-12: use unattended local signing for the new mining wallet. The iPhone app is for viewing/managing the wallet; the native mining process will sign and submit directly. This is a proposed implementation specification, not an installed wallet importer or working miner.

Companions: [mining plan](NATIVE-MINING-PLAN.md) and [verified findings](FINDINGS.md).

## What this can guarantee, and what it cannot

There is no foolproof way to retain a found Hashcats proof. It expires when another cat changes previous work or its anchor becomes too old. Correct signing, multiple RPCs and disk persistence cannot extend that validity.

Mining also has no accumulating partial proof: unsuccessful hashes do not become progress toward a guaranteed win. Saving a nonce counter prevents duplicate searching, but cannot preserve a job that the chain has invalidated. A qualifying hash is a chance to submit a mint, not yet an owned cat.

The engineering objective is to discover wallet/configuration bugs **before searching**, reduce work between discovery and broadcast, and recover unambiguously when a response is lost. The miner must not present itself as ready for paid operation while its signer is unavailable.

## 1. Setup from the iPhone wallet

The user's twelve words are a secret recovery phrase, not twelve private keys. Robinhood distinguishes the recovery phrase from an individual account's transaction-signing private key. This workflow assumes the self-custody **Robinhood Wallet** app, consistent with having a recovery phrase. [Robinhood Wallet FAQ](https://robinhood.com/us/en/support/articles/robinhood-wallet-faqs/).

Human setup, once the local import command exists:

1. In Robinhood Wallet on the iPhone, copy the new wallet's public `0x…` address for the EVM/Robinhood Chain account. This is the expected mining address.
2. Run the importer locally on the mining PC. Enter the recovery phrase into a hidden terminal prompt, not a command-line argument or chat message.
3. The importer derives the account and displays **only its public address**. It must match the address copied from the iPhone, comparing decoded address bytes. A phrase checksum passing is not sufficient.
4. If the address differs, stop setup and resolve the wallet's derivation path/account choice. Do not mine to the mismatch. The common Ethereum path `m/44'/60'/0'/0/0` is a candidate, not a Robinhood-specific path confirmed by this investigation. An optional mnemonic passphrase, if one was originally used, is distinct from the app PIN or keystore password. [Ethers wallet and HD derivation documentation](https://docs.ethers.org/v6/api/wallet/).
5. Save only the selected account's key in an encrypted local keystore, outside the repository, for example `/home/hamza/.local/share/hashcats/wallet.json`. On later runs, unlock that file once; do not repeat mnemonic derivation at each solution.
6. Verify the ETH balance through the Robinhood Chain RPC for this exact address. ETH on another network does not satisfy this chain's balance requirement. Read the mint price live rather than using the earlier 0.08176 ETH snapshot as a constant.

Keep secret input local; implementation logs and support messages need only the public address. No WalletConnect pairing, iPhone approval, browser extension or open phone app is required during native submission once the same signing account is available locally.

After inclusion, the NFT belongs to the on-chain recipient address. Whether the iPhone app immediately displays its artwork is separate from whether the mint succeeded; receipts and the collection's ownership state are the evidence.

## 2. Chosen implementation

Use **CUDA C++ for nonce searching** and **Node.js with ethers v6 for the host controller and signer**. Choose and lock a concrete ethers release during implementation. Node is already available in this workspace; no wallet dependency was installed for this document.

The host owns chain state, candidate verification, ABI encoding, account transaction nonces, signing, broadcasting and receipts. A local CUDA worker receives public job data and returns candidate records over a framed pipe. GPU batches keep running independently of normal asynchronous host RPC activity. A pipe disconnect terminates/pause-stops GPU search instead of leaving an orphan miner.

Keep one host controller and one active transaction owner for this wallet. Do not add a remote signing service, browser bridge, phone automation or multi-service deployment for the initial version.

Ethers supplies encrypted JSON wallet loading and local transaction signing. Load/decrypt once before arming. Signing a fully specified transaction and broadcasting its serialized bytes are separate operations; signing itself need not make RPC calls. [Wallet API](https://docs.ethers.org/v6/api/wallet/) and [signer/provider API](https://docs.ethers.org/v6/api/providers/).

## 3. Readiness gate before the GPU starts

The controller reaches `ARMED` only after all of these checks pass:

| Check | Failure caught before mining |
| --- | --- |
| Keystore opens and address equals expected iPhone address | Wrong password, wrong account or derivation |
| Offline signing exercise: serialize, sign, decode, recover sender, compare every transaction field; never broadcast the exercise | Broken signer, wrong sender/chain, serialization errors |
| Hash vectors, ABI encoding and original-anchor association pass | Incorrect proof or call construction |
| RPC chain ID is 4663 and collection code exists at the configured address | Wrong chain/destination or unavailable RPC |
| Address has enough native ETH for current price plus the configured fee allowance | Insufficient funds |
| Journal reconciles with pending/confirmed transaction counts and known receipts | Restart uncertainty or an outstanding transaction |
| Watcher has fresh coherent state and a usable anchor | Stale jobs or disconnected watcher |
| Fee policy is usable, candidate-path gas policy is defined, connections are warmed | Missing transaction fields or unavailable submit route |
| Current mint price and session allowance permit a mint | Accidental spending beyond the run's chosen limits |

The offline signing exercise does not demonstrate that an arbitrary `mine` call will succeed on mainnet. The first complete contract simulation requires an actually valid candidate, or a controlled local test setup for integration checks. Do not manufacture a “passed mainnet mint test” from a signed message or an expected `BadSolution` revert.

Continue checking readiness during mining. Stop issuing paid-search jobs when signing, nonce ownership, funding or chain freshness is lost; keep watching so the process can recover. An explicitly selected benchmark mode may search without funds, but it must report that it cannot mint.

For the first version, the user unlocks once per process start. A restarted locked process resumes receipt reconciliation and observation, but does not start paid mining until unlocked. Fully automatic recovery after a process/OS restart requires a separately chosen way to unlock the signer; a restart loop alone does not provide that capability.

## 4. Candidate-to-broadcast path

Prepare the ABI, destination, chain ID, current price, transaction type, fee information and account transaction nonce before a candidate arrives. Refresh dynamic values in the background. There are **two different nonces**: the GPU's proof nonce and the wallet's sequential transaction nonce. Keep their names and storage separate.

The winning proof nonce is unknown until discovery, so the complete mint transaction cannot be pre-signed. Once found, the remaining signing operation is local.

Chosen initial path:

1. **Validate:** CPU-rehash the candidate using its original miner, previous work and anchor; check its full target and freshness. Preserve the complete job with it.
2. **Record the candidate:** append its public proof/job fields and discovery time to a durable journal. Record it even if a subsequent operation fails, so recovery can explain what happened.
3. **Simulate and obtain gas:** use a fresh `eth_estimateGas` execution of the fully formed payable call with the correct sender. In this design that performs the candidate's execution check as well as estimating gas; do not also make a redundant `eth_call` unless it adds a specific needed check. Apply a tested gas margin within the configured ceiling. A successful estimate does not reserve the mint.
4. **Sign:** recheck obvious watcher invalidations, fill every transaction field explicitly, then sign locally. Decode/recover the signed result and assert it still contains the intended sender, chain, destination, value, proof nonce and original anchor block.
5. **Record the signed bytes:** persist serialized transaction, locally computed transaction hash, sender transaction nonce and attempt state before broadcast. A successful durable append must complete; journal failure stops submission and reports the error. This provides a known transaction identity after a crash, with a measurable latency cost.
6. **Broadcast immediately:** send identical signed bytes concurrently to at most two previously checked healthy RPC endpoints. Do not wait for the slower endpoint before processing the first response or watching for inclusion. With only one usable endpoint, send there immediately.
7. **Track inclusion:** check receipt status and the collection's mint/transfer event. Report a minted token only after success is evidenced; track subsequent reorgs separately.

This design removes phone approval, password entry, mnemonic derivation and generic transaction-population calls from the discovery path. It retains one candidate execution/gas check and durable records initially. Measure those costs before considering a faster policy that omits simulation; that change would accept more revert risk.

The ethers `signTransaction` method does not populate missing transaction fields, whereas `sendTransaction` calls a population step. Explicit fields make network dependencies visible in this latency-sensitive path. [Ethers signer/provider documentation](https://docs.ethers.org/v6/api/providers/).

## 5. Journal and recovery rules

Use one append-only local journal with complete records and explicit durable flushes at the candidate and signed-transaction boundaries. It stores no mnemonic or private key. The wallet identity and chain ID are part of every attempt. On restart, detect an incomplete trailing record and reconcile all complete signed records against the chain before new submissions.

| State | Meaning | Recovery |
| --- | --- | --- |
| `FOUND` | Verified candidate recorded; no signed transaction recorded | Recheck proof validity; continue only while still eligible |
| `SIGNED` | Original serialized transaction and hash persisted | Query receipt/pending state; broadcast the same bytes only if appropriate |
| `BROADCAST_UNKNOWN` | A send may have reached an RPC, but its response was lost | Look up the known hash across healthy endpoints; do not create a new attempt blindly |
| `PENDING` | Transaction observed/acknowledged; no successful receipt yet | Continue tracking and reconcile sender nonce; acknowledgement is not finality |
| `INCLUDED_SUCCESS` | Receipt succeeds and expected collection event exists | Record token ID and block hash, then track canonicality |
| `INCLUDED_REVERT` | Included transaction failed | Record gas, consume its account nonce, refresh the mining job |
| `STALE_UNSENT` | Proof invalidated before any possible broadcast | Retire the candidate and build fresh work |
| `UNRESOLVED` | Conflicting nonce, receipt or chain evidence | Pause new submissions until reconciled |

“Already known” may be a normal result when both endpoints receive the same signed transaction. The two submissions have one hash and do not create two independent mint payments. “Nonce too low” requires reconciliation; it does not automatically mean this mint succeeded.

If a transaction may already have been broadcast, never mark its nonce free merely because its proof has become stale. It can still be pending and later revert. Fee replacements, if implemented, must preserve the sender nonce, retain both hashes in the journal, and be bounded; a new proof is not a blind replacement for an old transaction.

For version one, allow one pending mint per wallet and pause additional mint submissions until its result is resolved. Viewing the wallet on the iPhone is fine; initiating another outgoing transaction from it during a mining session can disrupt the controller's nonce assumptions. Detect that and reconcile.

There remains a small loss window between GPU discovery and the first durable record, and any restart may take longer than the proof remains valid. Disk recording enables diagnosis/recovery of still-valid work, not guaranteed preservation.

## 6. Prove the workflow before trusting it with a rare find

Build a deterministic local integration scenario with a controllable proof target, then exercise the actual controller, signer, journal and broadcast/receipt interfaces. It validates workflow behavior; it is not a substitute for the production contract's acceptance checks.

Required failure cases:

- Wrong wallet/address, unavailable signer and insufficient funds prevent arming.
- A previous-work change during verification or simulation retires the old proof.
- Expiring anchors are rejected with a submission-time margin.
- A target or price change is handled without mutating the candidate's preimage.
- Kill/restart at each journal boundary, including immediately after broadcast but before a response.
- First RPC accepts but times out; second returns “already known”; only the original transaction is tracked.
- One RPC hangs while the other succeeds; the slow request does not block progress.
- External wallet nonce use, a reverted receipt and a reorg do not trigger a false success or duplicate submission.
- A candidate arriving from an older GPU batch retains the correct original job.

Report candidate-to-CPU-verification, journal flush, execution estimate, signing, first-broadcast and inclusion times separately, including p95/p99. Choose a numeric latency budget after measuring this PC and these endpoints; no sub-100-ms or guaranteed-next-block claim has been established.

## 7. What to do now

The next user input is the **public `0x…` address shown in Robinhood Wallet on the iPhone**. It lets implementation pin the correct mining recipient and lets read-only checks inspect chain balance and address-specific target. The twelve words are not needed in this conversation.

The next implementation package is the local import/unlock command, offline signing/readiness check, and journal-backed unsigned/shadow controller. Implement and validate that path before connecting live CUDA search to paid submission. This document does not imply that those commands already exist or that funds should be sent before address matching works.

## Source status

Robinhood's FAQ and ethers v6 wallet/provider documentation were checked live and archived through the running Khiip daemon:

- Robinhood FAQ: capture `01M2B8TMEG34F0149WRR6DK39Z`, `/home/hamza/khiip-vault/captures/web/robinhood-wallet-faq-robinhood.md`.
- Ethers wallets: capture `01M2B8SFTE2QW5ZKFWFAP8A95K`, `/home/hamza/khiip-vault/captures/web/documentation.md`.
- Ethers providers/signers: capture `01M2B8TNBQPWPP5P6SPFZ9RNHJ`, `/home/hamza/khiip-vault/captures/web/documentation-2.md`.

Protocol findings are sourced in the companion documents. The Robinhood-specific derivation path, imported account match, balance, signer operation and broadcast path remain unverified for the user's wallet. No additional wallet app is needed for the chosen design.
