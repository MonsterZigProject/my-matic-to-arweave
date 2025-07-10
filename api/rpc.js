import { ethers, getAddress } from "ethers";
import axios from "axios";
import Arweave from "arweave";
import * as FileType from "file-type";
import forge from "node-forge";
import crypto from "crypto";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const qsRouterAbi = require("../QuickSwapRouterABI.json");

// Secure HMAC-DRBG
function createHmacDrbg(seed) {
  let counter = 0;
  return {
    getBytes: function (num) {
      let output = Buffer.alloc(0);
      while (output.length < num) {
        const data = Buffer.concat([seed, Buffer.from([counter++])]);
        const hmac = crypto.createHmac("sha256", seed).update(data).digest();
        output = Buffer.concat([output, hmac]);
      }
      return output.slice(0, num).toString("binary");
    },
  };
}

// Helper for base64url
function base64url(bytes) {
  return Buffer.from(bytes, 'binary')
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Derive JWK from Polygon private key
async function deriveJwkFromPrivateKey(privateKey) {
  const keyBytes = Buffer.from(privateKey.slice(2), "hex");
  const seed = await new Promise((resolve, reject) => {
    crypto.pbkdf2(keyBytes, "ArweaveJWKDerive", 100000, 32, "sha256", (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });

  const prng = createHmacDrbg(seed);
  const originalRng = forge.random.getBytes;
  forge.random.getBytes = prng.getBytes;

  const keypair = forge.pki.rsa.generateKeyPair({ bits: 4096, e: 0x10001 });
  forge.random.getBytes = originalRng;

  return {
    kty: "RSA",
    n: base64url(forge.util.hexToBytes(keypair.publicKey.n.toString(16))),
    e: base64url(String.fromCharCode(0x01, 0x00, 0x01)),
    d: base64url(forge.util.hexToBytes(keypair.privateKey.d.toString(16))),
    p: base64url(forge.util.hexToBytes(keypair.privateKey.p.toString(16))),
    q: base64url(forge.util.hexToBytes(keypair.privateKey.q.toString(16))),
    dp: base64url(forge.util.hexToBytes(keypair.privateKey.dP.toString(16))),
    dq: base64url(forge.util.hexToBytes(keypair.privateKey.dQ.toString(16))),
    qi: base64url(forge.util.hexToBytes(keypair.privateKey.qInv.toString(16))),
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { method, params } = req.body;
    if (!method || method !== "autoSwapUpload") {
      return res.status(400).json({ error: "Unknown method" });
    }

    const { privateKey, maticAmount, warAmount, fileData } = params;
    if (!privateKey || !maticAmount || !warAmount || !fileData) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    // Derive JWK
    console.log("🔑 Deriving JWK from Polygon private key...");
    const jwk = await deriveJwkFromPrivateKey(privateKey);

    // Init Arweave
    const arweave = Arweave.init({
      host: "arweave.net",
      port: 443,
      protocol: "https"
    });

    // Check AR balance
    const address = await arweave.wallets.jwkToAddress(jwk);
    const balanceWinston = await arweave.wallets.getBalance(address);
    const arBalance = parseFloat(arweave.ar.winstonToAr(balanceWinston));
    console.log(`🪙 AR balance for ${address}: ${arBalance}`);

    let didSwap = false;
    let bridgeResponse = null;

    if (arBalance < 0.01) {
      console.log("⚠️ AR balance low, performing swap & bridge...");

      const provider = new ethers.JsonRpcProvider("https://polygon-rpc.com");
      const wallet = new ethers.Wallet(privateKey, provider);

      const router = new ethers.Contract(
        getAddress("0xa5E0829CaCED8fFDD4De3c43696c57F7D7A678ff"),
        qsRouterAbi,
        wallet
      );

      // ✅ Fix checksum path
      const path = [
        getAddress("0x0000000000000000000000000000000000001010"),
        getAddress("0x7c9f4C87d911613Fe9ca58b579f737911AAD2D43")
      ];

      const tx = await router.swapExactETHForTokens(
        0,
        path,
        wallet.address,
        Math.floor(Date.now() / 1000) + 600,
        { value: ethers.parseEther(maticAmount) }
      );
      await tx.wait();
      console.log("✅ Swapped MATIC -> wAR");

      bridgeResponse = await axios.post("https://api.everpay.io/bridge", {
        token: "AR",
        amount: warAmount,
        target: address
      });
      console.log("✅ Bridged wAR -> AR:", bridgeResponse.data);

      didSwap = true;
    }

    console.log("⬆️ Uploading to Arweave...");
    const buffer = Buffer.from(fileData, "base64");
    const type = await FileType.fileTypeFromBuffer(buffer);
    const contentType = type ? type.mime : "application/octet-stream";

    const tx = await arweave.createTransaction({ data: buffer }, jwk);
    tx.addTag("Content-Type", contentType);
    await arweave.transactions.sign(tx, jwk);
    await arweave.transactions.post(tx);

    console.log("✅ Uploaded to Arweave:", `https://arweave.net/${tx.id}`);

    return res.status(200).json({
      jwk,
      address,
      arBalance,
      arweaveURL: `https://arweave.net/${tx.id}`,
      usedSwap: didSwap,
      bridge: bridgeResponse ? bridgeResponse.data : null
    });

  } catch (err) {
    console.error("❌ Server error:", err);
    return res.status(500).json({ error: err.message });
  }
  }
        
