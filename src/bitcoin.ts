import * as ecc from "tiny-secp256k1";
import { BIP32Factory } from "bip32";
import { BIP47Factory } from "@dojo-tools/bip47";
import { bitcoinMessageFactory } from "@dojo-tools/bitcoinjs-message";
import { payments, Psbt, Transaction } from "bitcoinjs-lib";
import {
  ISSUANCE_LIMIT, profiles, requireCondition,
  type Config, type NetworkName, type Pending,
} from "./config.js";

const bip32 = BIP32Factory(ecc);
export const bip47 = BIP47Factory(ecc);
export const messages: ReturnType<typeof bitcoinMessageFactory> =
  bitcoinMessageFactory(ecc);

export function createWallet(seedHex: string, networkName: NetworkName) {
  requireCondition(/^[0-9a-f]{128}$/.test(seedHex), "Invalid seed");
  const profile = profiles[networkName];
  const seed = Buffer.from(seedHex, "hex");
  const root = bip32.fromSeed(seed, profile.bitcoin);
  const account = `m/84'/${profile.coinType}'/0'`;
  const funding = root.derivePath(`${account}/0/0`);
  const change = root.derivePath(`${account}/1/0`);
  const sender = bip47.fromSeed(seed, true, profile.bitcoin);
  const fundingOutput = payments.p2wpkh({
    pubkey: funding.publicKey,
    network: profile.bitcoin,
  });
  requireCondition(fundingOutput.address, "Missing funding address");
  requireCondition(fundingOutput.output, "Missing funding script");

  return {
    sender,
    funding,
    change,
    fundingAddress: fundingOutput.address,
    fundingScript: fundingOutput.output,
    fundingPath: `${account}/0/0`,
  };
}

export function receiver(code: string, networkName: NetworkName) {
  return bip47.fromBase58(code, profiles[networkName].bitcoin);
}

// Samourai's SegWit flag: byte 79 of the 80-byte payment code body.
const SEGWIT_FEATURE_BYTE = 79;

/**
 * The SegWit form of a payment code. Both forms share the same keys and
 * addresses; the flag tells senders such as Ashigaru to pay P2WPKH.
 */
export function segwitCode(code: string, networkName: NetworkName): string {
  return withSegwitFlag(code, networkName, 1);
}

// Both forms of one payment code: SegWit first, then legacy.
export function codeForms(code: string, networkName: NetworkName): string[] {
  return [withSegwitFlag(code, networkName, 1), withSegwitFlag(code, networkName, 0)];
}

function withSegwitFlag(
  code: string,
  networkName: NetworkName,
  flag: 0 | 1,
): string {
  const network = profiles[networkName].bitcoin;
  const body = Uint8Array.from(bip47.fromBase58(code, network).paymentCode);
  body[SEGWIT_FEATURE_BYTE] = flag;
  return bip47.fromBuffer(body, network).toBase58();
}

export function deriveAddress(config: Config, index: number): string {
  requireCondition(
    Number.isSafeInteger(index) && index >= 0 && index < ISSUANCE_LIMIT,
    "Index outside the development issuance range",
  );
  const sender = createWallet(config.seedHex, config.network).sender;

  // The PUBLIC receiver invokes sender-side derivation in this library.
  // Calling the private sender's method reverses the payment direction.
  return receiver(config.merchantCode, config.network)
    .getPaymentAddress(sender, index, "p2wpkh");
}

// Hex public key of the address deriveAddress returns at this index.
export function derivePaymentPubkey(config: Config, index: number): string {
  requireCondition(
    Number.isSafeInteger(index) && index >= 0 && index < ISSUANCE_LIMIT,
    "Index outside the development issuance range",
  );
  const sender = createWallet(config.seedHex, config.network).sender;
  return Buffer.from(
    receiver(config.merchantCode, config.network)
      .derivePaymentPublicKey(sender, index),
  ).toString("hex");
}

export function buildNotification(
  config: Config,
  fundingHex: string,
  vout: number,
  feeSats: number,
): Pending {
  requireCondition(
    fundingHex.length <= 800000 &&
      /^(?:[0-9a-fA-F]{2})+$/.test(fundingHex),
    "Invalid funding transaction hex",
  );
  requireCondition(
    Number.isSafeInteger(vout) && vout >= 0,
    "Invalid funding output index",
  );
  requireCondition(
    Number.isSafeInteger(feeSats) &&
      feeSats >= 200 && feeSats <= 10000,
    "Development fee must be between 200 and 10000 sats",
  );

  const network = profiles[config.network].bitcoin;
  const wallet = createWallet(config.seedHex, config.network);
  const merchant = receiver(config.merchantCode, config.network);
  const previous = Transaction.fromHex(fundingHex);
  const output = previous.outs[vout];

  requireCondition(output, "Funding output does not exist");
  requireCondition(
    Buffer.from(output.script).equals(Buffer.from(wallet.fundingScript)),
    "Funding output does not belong to this dispenser",
  );
  requireCondition(
    output.value <= 1000000n,
    "Development build refuses funding outputs above 1000000 sats",
  );

  const notificationValue = 546n;
  const changeValue = output.value - BigInt(feeSats) - notificationValue;
  requireCondition(changeValue >= 330n, "Insufficient funding and change");
  requireCondition(wallet.funding.privateKey, "Missing funding private key");

  const outpoint = Buffer.alloc(36);
  Buffer.from(previous.getId(), "hex").reverse().copy(outpoint);
  outpoint.writeUInt32LE(vout, 32);

  const payload = Buffer.from(
    wallet.sender.getBlindedPaymentCode(
      merchant, outpoint, wallet.funding.privateKey,
    ),
    "hex",
  );
  const dataScript = payments.embed({ data: [payload] }).output;
  const changeAddress = payments.p2wpkh({
    pubkey: wallet.change.publicKey, network,
  }).address;

  requireCondition(dataScript && changeAddress, "Output construction failed");

  const psbt = new Psbt({ network });
  psbt.addInput({
    hash: previous.getId(),
    index: vout,
    sequence: 0xffffffff,
    nonWitnessUtxo: Buffer.from(fundingHex, "hex"),
    witnessUtxo: { script: output.script, value: output.value },
  });
  psbt.addOutput({
    address: merchant.getNotificationAddress(),
    value: notificationValue,
  });
  psbt.addOutput({ script: dataScript, value: 0n });
  psbt.addOutput({ address: changeAddress, value: changeValue });
  psbt.signInput(0, wallet.funding);

  requireCondition(
    psbt.validateSignaturesOfInput(
      0,
      (pubkey, hash, signature) => ecc.verify(hash, pubkey, signature),
    ),
    "Local signature validation failed",
  );

  psbt.finalizeAllInputs();
  const tx = psbt.extractTransaction();
  const feeRate = feeSats / tx.virtualSize();
  requireCondition(feeRate <= 100, "Development fee-rate limit exceeded");

  return {
    fundingHex,
    vout,
    feeSats,
    txid: tx.getId(),
    hex: tx.toHex(),
    recipient: merchant.getNotificationAddress(),
    changeSats: Number(changeValue),
    feeRate,
  };
}

export function identityStatement(config: Config, pending: Pending): string {
  const dispenser = createWallet(config.seedHex, config.network)
    .sender.toBase58();

  return [
    "NymDispenser identity approval v2",
    `Onion: ${config.onion}`,
    `Network: ${config.network}`,
    `Merchant: ${config.merchantCode}`,
    `Dispenser: ${dispenser}`,
    `Notification: ${pending.txid}`,
    "Output type: p2wpkh",
    `Approved indices: 0 through ${ISSUANCE_LIMIT - 1}`,
    "",
    "I approve this development installation.",
    "I have verified receipt and spending using this connection.",
    "My receiving wallet is configured to discover the approved indices.",
    "This binds an identity; it does not independently prove served addresses.",
  ].join("\n");
}

/**
 * The exact text a valid signature covers, if any. Ashigaru's PayNym
 * signing appends "\n\nBIP47: <payment code>"; only the merchant's own
 * code is accepted there, in either its SegWit or legacy form.
 */
export function signedStatement(
  config: Config,
  pending: Pending,
  signature: string,
): string | undefined {
  const statement = identityStatement(config, pending);
  const address = receiver(config.merchantCode, config.network)
    .getNotificationAddress();
  const texts = [statement, ...codeForms(config.merchantCode, config.network)
    .map(code => `${statement}\n\nBIP47: ${code}`)];
  return texts.find(text => {
    try {
      return messages.verify(
        text, address, signature,
        profiles[config.network].bitcoin.messagePrefix,
      );
    } catch {
      return false;
    }
  });
}

export function verifyIdentity(
  config: Config,
  pending: Pending,
  signature: string,
): boolean {
  return signedStatement(config, pending, signature) !== undefined;
}

export function reconstruct(config: Config, pending: Pending): Pending {
  const rebuilt = buildNotification(
    config, pending.fundingHex, pending.vout, pending.feeSats,
  );
  requireCondition(
    rebuilt.txid === pending.txid && rebuilt.hex === pending.hex,
    "Saved notification failed local reconstruction",
  );
  return rebuilt;
}
