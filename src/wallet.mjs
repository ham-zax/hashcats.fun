import { createInterface, emitKeypressEvents } from "node:readline";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { HDNodeWallet, Wallet, Transaction, getAddress } from "ethers";
import { CHAIN_ID, COLLECTION, ABI } from "./protocol.mjs";

export async function ask(prompt) {
  const reader = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await new Promise((resolve) => reader.question(prompt, resolve));
  } finally {
    reader.close();
  }
}

export function secretPrompt(prompt) {
  if (!process.stdin.isTTY)
    throw new Error("Secret input requires an interactive terminal");
  return new Promise((resolve, reject) => {
    let value = "";
    const wasRaw = process.stdin.isRaw;
    emitKeypressEvents(process.stdin);
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    function finish(error) {
      process.stdin.removeListener("keypress", keypress);
      process.stdin.setRawMode(Boolean(wasRaw));
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    }
    function keypress(text, key = {}) {
      if (key.ctrl && (key.name === "c" || key.name === "d"))
        return finish(new Error("Cancelled"));
      if (key.name === "return" || key.name === "enter") return finish();
      if (key.name === "backspace") {
        value = Array.from(value).slice(0, -1).join("");
        return;
      }
      if (!key.ctrl && !key.meta && text && !text.includes("\u001b"))
        value += text;
    }
    process.stdin.on("keypress", keypress);
  });
}

export function importMnemonic(
  phrase,
  expectedAddress,
  path = "m/44'/60'/0'/0/0",
  passphrase = "",
) {
  let derived;
  try {
    derived = HDNodeWallet.fromPhrase(
      phrase.trim().replace(/\s+/g, " "),
      passphrase,
      path,
    );
  } catch {
    throw new Error(
      "Invalid recovery phrase or derivation path (secret input omitted)",
    );
  }
  if (getAddress(expectedAddress) !== derived.address) {
    throw new Error(
      `Derived ${derived.address}; expected ${getAddress(expectedAddress)}. Check derivation path/account.`,
    );
  }
  // Persist only this account, not its parent seed or other derivable accounts.
  return new Wallet(derived.privateKey);
}

export async function saveWallet(wallet, path, password) {
  if (!password) throw new Error("Keystore password must not be empty");
  const encrypted = await new Wallet(wallet.privateKey).encrypt(password);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(encrypted);
    await file.sync();
  } finally {
    await file.close();
  }
}

export async function walletAddress(path) {
  const stored = JSON.parse(await readFile(path, "utf8"));
  if (
    stored.version !== 3 ||
    !stored.address ||
    !(stored.crypto || stored.Crypto)
  )
    throw new Error("Not a valid JSON keystore");
  return getAddress(
    stored.address.startsWith("0x") ? stored.address : `0x${stored.address}`,
  );
}

export async function unlockWallet(path, password) {
  const encrypted = await readFile(path, "utf8");
  try {
    return await Wallet.fromEncryptedJson(encrypted, password);
  } catch {
    throw new Error("Cannot unlock keystore: wrong password or damaged file");
  }
}

export async function checkSigner(
  wallet,
  chainId = CHAIN_ID,
  collection = COLLECTION,
) {
  const request = {
    type: 0,
    chainId,
    to: collection,
    nonce: 0,
    gasPrice: 1n,
    gasLimit: 100000n,
    value: 0n,
    data: ABI.encodeFunctionData("mine", [1n, 1n]),
  };
  const signed = await wallet.signTransaction(request);
  assertSigned(signed, wallet.address, request);
  // Deliberately not returned, persisted, or broadcast: this is an offline exercise.
}

export function assertSigned(signed, sender, request) {
  const decoded = Transaction.from(signed);
  if (
    decoded.from !== getAddress(sender) ||
    decoded.to !== getAddress(request.to) ||
    decoded.chainId !== BigInt(request.chainId) ||
    decoded.nonce !== request.nonce ||
    decoded.value !== request.value ||
    decoded.gasLimit !== request.gasLimit ||
    decoded.gasPrice !== request.gasPrice ||
    decoded.type !== request.type ||
    decoded.data !== request.data
  )
    throw new Error("Signed transaction does not match intended mint");
  return decoded;
}
