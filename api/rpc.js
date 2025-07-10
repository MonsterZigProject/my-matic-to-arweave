import { ethers } from "ethers";
import axios from "axios";
import Arweave from "arweave";
import * as FileType from "file-type";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const qsRouterAbi = require("../../QuickSwapRouterABI.json");

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

    const arweave = Arweave.init({ host: "arweave.net", port: 443, protocol: "https" });

    const address = await arweave.wallets.jwkToAddress(jwk);
    const winstonBalance = await arweave.wallets.getBalance(address);
    const arBalance = parseFloat(arweave.ar.winstonToAr(winstonBalance));
    console.log(`AR balance: ${arBalance}`);

    let didSwap = false;
    let bridgeResult = null;

    if (arBalance < 0.01) {
      const provider = new ethers.JsonRpcProvider("https://polygon-rpc.com");
      const wallet = new ethers.Wallet(privateKey, provider);

      const quickswapRouter = new ethers.Contract(
        "0xa5E0829CaCED8fFDD4De3c43696c57F7D7A678ff",
        qsRouterAbi,
        wallet
      );

      const tx = await quickswapRouter.swapExactETHForTokens(
        0,
        ["0x0000000000000000000000000000000000001010", "0x7c9f4C87d911613Fe9ca58b579f737911AAD2D43"],
        wallet.address,
        Math.floor(Date.now() / 1000) + 600,
        { value: ethers.parseEther(maticAmount) }
      );
      await tx.wait();
      console.log("✅ Swapped MATIC -> wAR");

      bridgeResult = await axios.post("https://api.everpay.io/bridge", {
        token: "AR",
        amount: warAmount,
        target: address
      });
      console.log("✅ Bridged wAR -> AR:", bridgeResult.data);

      didSwap = true;
    }

    const buffer = Buffer.from(fileData, "base64");
    const type = await FileType.fileTypeFromBuffer(buffer);
    const contentType = type ? type.mime : "application/octet-stream";

    const arTx = await arweave.createTransaction({ data: buffer }, jwk);
    arTx.addTag("Content-Type", contentType);
    await arweave.transactions.sign(arTx, jwk);
    await arweave.transactions.post(arTx);

    return res.status(200).json({
      result: `https://arweave.net/${arTx.id}`,
      contentType,
      usedSwap: didSwap,
      bridge: bridgeResult ? bridgeResult.data : null
    });

  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ error: err.message });
  }
}
