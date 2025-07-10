import { ethers } from "ethers";
import axios from "axios";
import Arweave from "arweave";
import * as FileType from "file-type";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const qsRouterAbi = require("../QuickSwapRouterABI.json");

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { method, params } = req.body;
    if (!method || method !== "autoSwapUpload") {
      return res.status(400).json({ error: "Unknown method" });
    }

    const { privateKey, maticAmount, warAmount, fileData, jwk } = params;
    if (!privateKey || !maticAmount || !warAmount || !fileData || !jwk) {
      return res.status(400).json({ error: "Missing parameters" });
    }

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
    console.log(`AR balance for ${address}: ${arBalance}`);

    let didSwap = false;
    let bridgeResponse = null;

    if (arBalance < 0.01) {
      // Connect to Polygon
      const provider = new ethers.JsonRpcProvider("https://polygon-rpc.com");
      const wallet = new ethers.Wallet(privateKey, provider);

      // Swap MATIC -> wAR on QuickSwap
      const router = new ethers.Contract(
        "0xa5E0829CaCED8fFDD4De3c43696c57F7D7A678ff",
        qsRouterAbi,
        wallet
      );

      const tx = await router.swapExactETHForTokens(
        0,
        ["0x0000000000000000000000000000000000001010", "0x7c9f4C87d911613Fe9ca58b579f737911AAD2D43"],
        wallet.address,
        Math.floor(Date.now() / 1000) + 600,
        { value: ethers.parseEther(maticAmount) }
      );
      await tx.wait();
      console.log("✅ Swapped MATIC -> wAR");

      // Bridge wAR -> AR
      bridgeResponse = await axios.post("https://api.everpay.io/bridge", {
        token: "AR",
        amount: warAmount,
        target: address
      });
      console.log("✅ Bridged wAR -> AR:", bridgeResponse.data);

      didSwap = true;
    }

    // Upload to Arweave
    const buffer = Buffer.from(fileData, "base64");
    const type = await FileType.fileTypeFromBuffer(buffer);
    const contentType = type ? type.mime : "application/octet-stream";

    const tx = await arweave.createTransaction({ data: buffer }, jwk);
    tx.addTag("Content-Type", contentType);
    await arweave.transactions.sign(tx, jwk);
    await arweave.transactions.post(tx);

    return res.status(200).json({
      result: `https://arweave.net/${tx.id}`,
      contentType,
      usedSwap: didSwap,
      bridge: bridgeResponse ? bridgeResponse.data : null
    });

  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ error: err.message });
  }
}
