import { ethers } from "ethers";
import axios from "axios";
import Arweave from "arweave";
import FileType from "file-type";
import qsRouterAbi from "../../QuickSwapRouterABI.json" assert { type: "json" };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { method, params } = req.body;

    if (method !== "autoSwapUpload") {
      return res.status(400).json({ error: "Unknown method" });
    }

    const { privateKey, maticAmount, warAmount, fileData, jwk } = params;

    if (!privateKey || !maticAmount || !warAmount || !fileData || !jwk) {
      return res.status(400).json({ error: "Missing required parameters" });
    }

    const arweave = Arweave.init({
      host: "arweave.net",
      port: 443,
      protocol: "https"
    });

    // =============== CHECK AR BALANCE
    const address = await arweave.wallets.jwkToAddress(jwk);
    const balance = await arweave.wallets.getBalance(address);
    const arBalance = parseFloat(arweave.ar.winstonToAr(balance));
    console.log(`✅ AR balance: ${arBalance} AR`);

    let didSwap = false;
    let bridgeResponse = null;

    // if balance < 0.01 AR (approx ~2kb file cost), fund
    if (arBalance < 0.01) {
      console.log(`💰 Not enough AR (${arBalance}). Proceed to swap & bridge.`);

      // =============== SWAP MATIC -> wAR
      const provider = new ethers.JsonRpcProvider("https://polygon-rpc.com");
      const wallet = new ethers.Wallet(privateKey, provider);

      const quickswapRouter = new ethers.Contract(
        "0xa5E0829CaCED8fFDD4De3c43696c57F7D7A678ff",
        qsRouterAbi,
        wallet
      );

      const wmatic = "0x0000000000000000000000000000000000001010";
      const wAR = "0x7c9f4C87d911613Fe9ca58b579f737911AAD2D43";

      const swapTx = await quickswapRouter.swapExactETHForTokens(
        0,
        [wmatic, wAR],
        wallet.address,
        Math.floor(Date.now() / 1000) + 60 * 10,
        { value: ethers.parseEther(maticAmount.toString()) }
      );
      await swapTx.wait();
      console.log(`✅ Swapped ${maticAmount} MATIC to wAR`);

      // =============== BRIDGE wAR -> AR
      bridgeResponse = await axios.post("https://api.everpay.io/bridge", {
        token: "AR",
        amount: warAmount,
        target: address
      });
      console.log("✅ Bridge response:", bridgeResponse.data);

      didSwap = true;
    } else {
      console.log(`✅ Enough AR balance. Skipping swap & bridge.`);
    }

    // =============== UPLOAD TO ARWEAVE
    const buffer = Buffer.from(fileData, "base64");
    const detectedType = await FileType.fileTypeFromBuffer(buffer);
    const contentType = detectedType ? detectedType.mime : 'application/octet-stream';

    const tx = await arweave.createTransaction({ data: buffer }, jwk);
    tx.addTag("Content-Type", contentType);

    await arweave.transactions.sign(tx, jwk);
    await arweave.transactions.post(tx);

    console.log(`✅ Uploaded to Arweave: https://arweave.net/${tx.id}`);

    return res.status(200).json({
      result: `https://arweave.net/${tx.id}`,
      contentType,
      usedSwap: didSwap,
      bridge: bridgeResponse
    });

  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
}
