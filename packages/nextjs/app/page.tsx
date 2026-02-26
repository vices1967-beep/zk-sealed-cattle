/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useAccount, useContract, useProvider } from "@starknet-react/core";
import { useState, useMemo, useEffect, useCallback } from "react";
import { poseidonHashMany } from "micro-starknet";
import toast from "react-hot-toast";
import deployedContracts from "~~/contracts/deployedContracts";
import { useCavos } from '@cavos/react';

const contractData = deployedContracts.sepolia?.SealedBidFeedlot;

const RAZAS = ["Angus", "Hereford", "Braford", "Brangus", "Limousin", "Charolais", "Otra"];

interface LotMetadata {
  nombre?: string;
  productor?: string;
  raza?: string;
  peso_promedio_kg?: number;
  cantidad_animales?: number;
  fecha_creacion?: string;
  certificaciones?: string[];
  imagenes?: string[];
  descripcion?: string;
}

// IPFS Gateway configuration (from environment)
const IPFS_GATEWAY = process.env.NEXT_PUBLIC_IPFS_GATEWAY || 'https://gateway.pinata.cloud';

/**
 * Converts any address-like value to a 64-character hex string prefixed with 0x.
 * @param addr - Address in various possible formats (bigint, string)
 * @returns Normalized hex address
 */
function toHexAddress(addr: any): string {
  if (!addr) return "0x0";
  try {
    const big = BigInt(addr);
    return "0x" + big.toString(16).padStart(64, "0");
  } catch {
    return String(addr);
  }
}

/**
 * Normalizes an address by removing leading zeros and ensuring 0x prefix.
 * @param addr - Raw address string
 * @returns Normalized address string
 */
function normalizeAddress(addr: string): string {
  if (!addr) return "";
  const hex = addr.replace("0x", "").replace(/^0+/, "");
  return "0x" + (hex || "0");
}

// Verifier addresses from environment variables
const VERIFIER_ADDRESS = process.env.NEXT_PUBLIC_PAYMENT_VERIFIER_ADDRESS || '';
const AUCTION_VERIFIER_ADDRESS = process.env.NEXT_PUBLIC_AUCTION_VERIFIER_ADDRESS || '';

export default function Home() {
  const { account: walletAccount } = useAccount();
  const { contract } = useContract({
    abi: contractData?.abi,
    address: contractData?.address,
  });
  const { provider } = useProvider();

  // Cavos hooks
  const { 
    address: cavosAddress, 
    isAuthenticated: isCavosAuth, 
    execute: cavosExecute,
    logout: cavosLogout
  } = useCavos();

  // Unified active account: Cavos takes precedence if authenticated
  const activeAccount = isCavosAuth ? cavosAddress : walletAccount;
  const activeAccountAddress = isCavosAuth ? cavosAddress : walletAccount?.address;

  /**
   * Unified transaction execution function that works with both Cavos and traditional wallets.
   * @param call - Transaction call object
   * @returns Object containing transaction hash
   */
  const executeTransaction = async (call: any) => {
    if (isCavosAuth) {
      const txHash = await cavosExecute(call);
      return { transaction_hash: txHash };
    } else if (walletAccount) {
      const tx = await walletAccount.execute([call]);
      return tx;
    } else {
      throw new Error("No account connected");
    }
  };

  const [owner, setOwner] = useState<string | null>(null);
  const [isOwner, setIsOwner] = useState(false);

  // Default producer address (owner)
  const DEFAULT_PRODUCER = "0x0626bb9241ba6334ae978cfce1280d725e727a6acb5e61392ab4cee031a4b7ca";

  const [newProductor, setNewProductor] = useState(DEFAULT_PRODUCER);
  const [newRaza, setNewRaza] = useState("");
  const [newPeso, setNewPeso] = useState("");
  const [newCantidad, setNewCantidad] = useState("");
  const [newMetadataHash, setNewMetadataHash] = useState(""); // only IPFS hash, no prefix
  const [newDuration, setNewDuration] = useState("360000"); // 100 hours
  const [nextLotId, setNextLotId] = useState("1");

  const [lots, setLots] = useState<any[]>([]);
  const [loadingLots, setLoadingLots] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedLotId, setSelectedLotId] = useState<string>("");
  const [selectedLotInfo, setSelectedLotInfo] = useState<any>(null);
  const [selectedLotMetadata, setSelectedLotMetadata] = useState<LotMetadata | null>(null);
  const [currentTime, setCurrentTime] = useState(Math.floor(Date.now() / 1000));

  const [amount, setAmount] = useState("");
  const [nonce, setNonce] = useState(Math.floor(Math.random() * 1000000).toString());
  const [isLoading, setIsLoading] = useState(false);
  const [committed, setCommitted] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [commitment, setCommitment] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  const [participatedLotes, setParticipatedLotes] = useState<Record<string, boolean>>({});
  const [proofGeneratedLotes, setProofGeneratedLotes] = useState<Record<string, boolean>>({});
  const [zkFinalizedLotes, setZkFinalizedLotes] = useState<Record<string, boolean>>({});

  /**
   * Computes the Poseidon commitment for a bid.
   * @param secret - Secret nonce
   * @param amount - Bid amount
   * @param lot_id - Lot ID
   * @param winner - Winner address
   * @returns Commitment as a string
   */
  const computeCommitment = (secret: bigint, amount: bigint, lot_id: bigint, winner: string) => {
    try {
      const winnerBigInt = BigInt(winner);
      const { low: amountLow } = splitU256(amount);
      const { low: lotIdLow } = splitU256(lot_id);
      const hash = poseidonHashMany([secret, amountLow, lotIdLow, winnerBigInt]);
      return hash.toString();
    } catch (error) {
      console.error("Error computing commitment:", error);
      throw error;
    }
  };

  /**
   * Computes the commitment preview for the UI.
   */
  const calculatedCommitment = useMemo(() => {
    if (!amount || !nonce || committed) return "";
    try {
      const amountBig = BigInt(amount);
      const nonceBig = BigInt(nonce);
      const { low, high } = splitU256(amountBig);
      return poseidonHashMany([low, high, nonceBig]).toString();
    } catch {
      return "";
    }
  }, [amount, nonce, committed]);

  // Load per‑account data from localStorage
  useEffect(() => {
    if (!activeAccountAddress) {
      setParticipatedLotes({});
      setProofGeneratedLotes({});
      setZkFinalizedLotes({});
      return;
    }
    const accountKey = activeAccountAddress.toLowerCase();

    const savedParticipated = localStorage.getItem(`participatedLotes_${accountKey}`);
    setParticipatedLotes(savedParticipated ? JSON.parse(savedParticipated) : {});

    const savedProofGenerated = localStorage.getItem(`proofGeneratedLotes_${accountKey}`);
    setProofGeneratedLotes(savedProofGenerated ? JSON.parse(savedProofGenerated) : {});

    const savedZkFinalized = localStorage.getItem(`zkFinalizedLotes_${accountKey}`);
    setZkFinalizedLotes(savedZkFinalized ? JSON.parse(savedZkFinalized) : {});
  }, [activeAccountAddress]);

  // Save per‑account data
  useEffect(() => {
    if (!activeAccountAddress) return;
    const accountKey = activeAccountAddress.toLowerCase();
    localStorage.setItem(`participatedLotes_${accountKey}`, JSON.stringify(participatedLotes));
  }, [participatedLotes, activeAccountAddress]);

  useEffect(() => {
    if (!activeAccountAddress) return;
    const accountKey = activeAccountAddress.toLowerCase();
    localStorage.setItem(`proofGeneratedLotes_${accountKey}`, JSON.stringify(proofGeneratedLotes));
  }, [proofGeneratedLotes, activeAccountAddress]);

  useEffect(() => {
    if (!activeAccountAddress) return;
    const accountKey = activeAccountAddress.toLowerCase();
    localStorage.setItem(`zkFinalizedLotes_${accountKey}`, JSON.stringify(zkFinalizedLotes));
  }, [zkFinalizedLotes, activeAccountAddress]);

  // Clock
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Owner check
  useEffect(() => {
    if (activeAccountAddress) {
      const ownerAddress = (process.env.NEXT_PUBLIC_OWNER_ADDRESS || DEFAULT_PRODUCER).toLowerCase();
      setOwner(ownerAddress);
      const normalizedAccount = normalizeAddress(activeAccountAddress);
      const normalizedOwner = normalizeAddress(ownerAddress);
      setIsOwner(normalizedAccount === normalizedOwner);
    } else {
      setIsOwner(false);
    }
  }, [activeAccountAddress]);

  /**
   * Fetches all lots from the contract.
   * @param showRefreshing - Whether to show the refreshing spinner
   */
  const fetchAllLots = useCallback(async (showRefreshing = false) => {
    if (!contract) return;
    if (showRefreshing) setRefreshing(true);
    else setLoadingLots(true);
    try {
      const count = await contract.get_lot_count();
      const num = Number(count);
      setNextLotId(String(num + 1));
      const lotsArray = [];
      for (let i = 1; i <= num; i++) {
        try {
          const info = await contract.get_lot_info(i);
          let metadata = null;
          const metadataUri = info.metadata_uri ? info.metadata_uri.toString() : "";

          if (metadataUri.startsWith("ipfs://")) {
            const cid = metadataUri.replace("ipfs://", "");
            const gatewayUrl = `${IPFS_GATEWAY}/ipfs/${cid}`; // Use configured gateway
            try {
              const res = await fetch(gatewayUrl);
              if (res.ok) metadata = await res.json();
            } catch {
              // ignore
            }
          }

          const productorHex = toHexAddress(info.productor);
          const mejorPostorHex = toHexAddress(info.mejor_postor);

          lotsArray.push({
            id: i,
            productor: productorHex,
            raza: info.raza.toString(),
            peso_inicial: info.peso_inicial?.toString(),
            cantidad_animales: info.cantidad_animales?.toString(),
            metadata_uri: metadataUri,
            start_time: Number(info.start_time),
            duration: Number(info.duration),
            finalizado: info.finalizado,
            mejor_puja: info.mejor_puja?.toString() || "0",
            mejor_postor: mejorPostorHex,
            metadata,
          });
        } catch (e) {
          console.error(`Error fetching lot ${i}:`, e);
        }
      }
      setLots(lotsArray);
    } catch (e) {
      console.error("Error in fetchAllLots:", e);
      toast.error("Failed to load lots");
    } finally {
      setLoadingLots(false);
      setRefreshing(false);
    }
  }, [contract, setRefreshing, setLoadingLots, setNextLotId, setLots, toHexAddress, toast, IPFS_GATEWAY]);

  useEffect(() => {
    fetchAllLots();
  }, [fetchAllLots, contract, activeAccountAddress]); // Added fetchAllLots to dependencies

  /**
   * Handles selection of a lot.
   * @param lot - The lot object
   */
  const handleSelectLot = (lot: any) => {
    setSelectedLotId(lot.id.toString());
    setSelectedLotInfo(lot);
    setSelectedLotMetadata(lot.metadata);
    setCommitted(false);
    setRevealed(false);
    setCommitment("");
    setAmount("");
    setNonce(Math.floor(Math.random() * 1000000).toString());
  };

  /**
   * Checks if an auction is still active.
   * @param lot - The lot object
   * @returns True if active, false otherwise
   */
  const isAuctionActive = (lot: any) => {
    if (!lot) return false;
    if (lot.finalizado) return false;
    const endTime = lot.start_time + lot.duration;
    return currentTime < endTime;
  };

  /**
   * Returns a human-readable string of remaining time.
   * @param lot - The lot object
   * @returns Time remaining string or "Ended"
   */
  const getTimeRemaining = (lot: any) => {
    if (!lot) return "";
    const endTime = Number(lot.start_time) + Number(lot.duration);
    const remaining = endTime - currentTime;
    if (remaining <= 0) return "Ended";
    const hours = Math.floor(remaining / 3600);
    const minutes = Math.floor((remaining % 3600) / 60);
    const seconds = remaining % 60;
    return `${hours}h ${minutes}m ${seconds}s`;
  };

  /**
   * Converts breed index to human-readable name.
   * @param razaIndex - Index from contract
   * @returns Breed name
   */
  const getRazaNombre = (razaIndex: string) => {
    const index = parseInt(razaIndex, 10);
    return !isNaN(index) && RAZAS[index] ? RAZAS[index] : razaIndex;
  };

  /**
   * Splits a U256 value into low and high 128-bit parts.
   * @param value - BigInt value
   * @returns Object with low and high
   */
  const splitU256 = (value: bigint) => {
    const mask = (1n << 128n) - 1n;
    const low = value & mask;
    const high = value >> 128n;
    return { low, high };
  };

  /**
   * Creates a new lot (owner only).
   */
  const handleCreateLot = async () => {
    setErrorMessage("");
    if (!contract || !activeAccount) return;
    if (!isOwner) {
      setErrorMessage("❌ Only the owner can create lots");
      return;
    }
    setIsLoading(true);
    try {
      // Prepend ipfs:// to the hash if not already present
      const metadataUri = newMetadataHash.startsWith("ipfs://") 
        ? newMetadataHash 
        : `ipfs://${newMetadataHash}`;

      const call = contract.populate("create_lot", [
        BigInt(nextLotId),
        newProductor,
        newRaza,
        BigInt(newPeso),
        BigInt(newCantidad),
        metadataUri,
        BigInt(newDuration),
      ]);
      const tx = await executeTransaction(call);
      await provider.waitForTransaction(tx.transaction_hash);
      toast.success("✅ Lot created successfully");
      // Reset form (keep default producer)
      setNewProductor(DEFAULT_PRODUCER);
      setNewRaza("");
      setNewPeso("");
      setNewCantidad("");
      setNewMetadataHash("");
      setNewDuration("360000");
      await fetchAllLots();
    } catch (e: any) {
      console.error("Error in createLot:", e);
      toast.error("❌ Failed to create lot: " + (e.message || JSON.stringify(e)));
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Commits a bid.
   */
  const handleCommit = async () => {
    setErrorMessage("");
    if (!contract || !activeAccountAddress || !selectedLotId) return;
    if (!isAuctionActive(selectedLotInfo)) {
      toast.error("❌ Auction is not active");
      return;
    }
    setIsLoading(true);
    try {
      const secretBig = BigInt(nonce);
      const amountBig = BigInt(amount);
      const lotIdBig = BigInt(selectedLotId);
      const winnerAddr = activeAccountAddress;

      const poseidonCommitment = computeCommitment(secretBig, amountBig, lotIdBig, winnerAddr);

      const winnerAddrFormatted = toHexAddress(winnerAddr).toLowerCase();
      const key = `zk_${selectedLotId}_${winnerAddrFormatted}`;
      localStorage.setItem(
        key,
        JSON.stringify({
          secret: nonce,
          amount: amount,
          lot_id: selectedLotId,
          winner: winnerAddrFormatted,
          commitment: poseidonCommitment,
        })
      );

      const bidsKey = `bids_${selectedLotId}`;
      const currentBids = JSON.parse(localStorage.getItem(bidsKey) || "[]");
      currentBids.push({
        secret: nonce,
        amount: amount,
        lot_id: selectedLotId,
        winner: winnerAddrFormatted,
        commitment: poseidonCommitment,
      });
      localStorage.setItem(bidsKey, JSON.stringify(currentBids));

      const call = contract.populate("commit_bid", [selectedLotId, poseidonCommitment]);
      const tx = await executeTransaction(call);
      await provider.waitForTransaction(tx.transaction_hash);

      setCommitment(poseidonCommitment);
      setCommitted(true);
      toast.success("✅ Commit successful. Now reveal.");
    } catch (e: any) {
      console.error("Error in commit:", e);
      toast.error("❌ Commit failed: " + (e.message || JSON.stringify(e)));
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Reveals a previously committed bid.
   */
  const handleReveal = async () => {
    setErrorMessage("");
    if (!contract || !activeAccountAddress || !selectedLotId) return;
    if (!isAuctionActive(selectedLotInfo)) {
      toast.error("❌ Auction is not active");
      return;
    }
    setIsLoading(true);
    try {
      const winnerAddrFormatted = toHexAddress(activeAccountAddress).toLowerCase();
      const key = `zk_${selectedLotId}_${winnerAddrFormatted}`;
      const storedData = localStorage.getItem(key);
      if (!storedData) {
        toast.error("No commit data found for this account");
        setIsLoading(false);
        return;
      }
      const bid = JSON.parse(storedData);
      const amountToUse = bid.amount;
      const nonceToUse = bid.secret;
      const storedWinner = bid.winner.toLowerCase();

      if (storedWinner !== winnerAddrFormatted) {
        console.error("Winner address mismatch", { storedWinner, winnerAddrFormatted });
        toast.error("Winner address mismatch");
        setIsLoading(false);
        return;
      }

      const secretBig = BigInt(nonceToUse);
      const amountBig = BigInt(amountToUse);
      const lotIdBig = BigInt(selectedLotId);
      const computedCommitment = computeCommitment(secretBig, amountBig, lotIdBig, activeAccountAddress);
      console.log("Stored commitment:", bid.commitment);
      console.log("Computed commitment:", computedCommitment);
      if (computedCommitment !== bid.commitment) {
        toast.error("Local commitment mismatch");
        setIsLoading(false);
        return;
      }

      console.log("Reveal data:", { amountToUse, nonceToUse, winnerAddrFormatted });

      const { low: amountLow, high: amountHigh } = splitU256(BigInt(amountToUse));
      const { low: lotLow, high: lotHigh } = splitU256(BigInt(selectedLotId));
      const nonceHex = '0x' + BigInt(nonceToUse).toString(16);
      const calldataHex = [
        lotLow.toString(),
        lotHigh.toString(),
        amountLow.toString(),
        amountHigh.toString(),
        nonceHex
      ];
      const call = {
        contractAddress: contract.address,
        entrypoint: 'reveal_bid',
        calldata: calldataHex,
      };

      let txHash: string;
      if (isCavosAuth) {
        txHash = await cavosExecute(call);
        console.log("Cavos txHash:", txHash);
      } else if (walletAccount) {
        const tx = await walletAccount.execute([call]);
        txHash = tx.transaction_hash;
      } else {
        throw new Error("No account connected");
      }

      await provider.waitForTransaction(txHash);
      toast.success("✅ Bid revealed");

      const updatedInfo = await contract.get_lot_info(selectedLotId);
      const updatedLot = {
        id: selectedLotInfo.id,
        productor: toHexAddress(updatedInfo.productor),
        raza: updatedInfo.raza.toString(),
        peso_inicial: updatedInfo.peso_inicial?.toString(),
        cantidad_animales: updatedInfo.cantidad_animales?.toString(),
        metadata_uri: updatedInfo.metadata_uri?.toString() || "",
        start_time: Number(updatedInfo.start_time),
        duration: Number(updatedInfo.duration),
        finalizado: updatedInfo.finalizado,
        mejor_puja: updatedInfo.mejor_puja?.toString() || "0",
        mejor_postor: toHexAddress(updatedInfo.mejor_postor),
        metadata: selectedLotInfo.metadata,
      };
      setSelectedLotInfo(updatedLot);
      setLots(lots.map((l) => (l.id.toString() === selectedLotId ? updatedLot : l)));

      setParticipatedLotes((prev) => ({ ...prev, [selectedLotId]: true }));
      setRevealed(true);
    } catch (e: any) {
      console.error("Error in reveal:", e);
      toast.error("❌ Reveal failed: " + (e.message || JSON.stringify(e)));
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Dynamic ZK proof generation for payment.
   * Fetches the winning bid from localStorage and requests calldata from the backend.
   */
  const handleZKProof = async () => {
    if (!activeAccountAddress || !selectedLotInfo || !selectedLotInfo.finalizado) return;
    if (normalizeAddress(selectedLotInfo.mejor_postor) !== normalizeAddress(activeAccountAddress)) {
      toast.error("Only the winner can generate the ZK proof");
      return;
    }

    // Retrieve all bids for this lot from localStorage
    const allBids: Bid[] = JSON.parse(
      localStorage.getItem(`bids_${selectedLotId}`) || '[]'
    );
    if (allBids.length === 0) {
      toast.error("No bids found for this lot");
      return;
    }

    // Find the bid belonging to the current winner
    const winningBid = allBids.find(
      bid => normalizeAddress(bid.winner) === normalizeAddress(activeAccountAddress)
    );
    if (!winningBid) {
      toast.error("Winning bid not found in localStorage");
      return;
    }

    setIsLoading(true);
    try {
      const PAYMENT_BACKEND_URL = '/api/zk-payment';
      toast.loading("Generating payment proof via backend...");
      console.log("🌐 Sending payment bid to backend:", winningBid);

      const response = await fetch(PAYMENT_BACKEND_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bid: winningBid }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Backend error (${response.status}): ${errorText}`);
      }

      const { calldata }: { calldata: string[] } = await response.json();
      console.log("✅ Payment calldata received, length:", calldata.length);
      toast.dismiss();

      toast.loading("Verifying payment proof on-chain...");
      let txHash: string;
      if (isCavosAuth) {
        txHash = await cavosExecute({
          contractAddress: VERIFIER_ADDRESS,
          entrypoint: "verify_ultra_keccak_honk_proof",
          calldata: calldata.map(c => c.toString()),
        });
      } else if (walletAccount) {
        const tx = await walletAccount.execute({
          contractAddress: VERIFIER_ADDRESS,
          entrypoint: "verify_ultra_keccak_honk_proof",
          calldata: calldata.map(c => c.toString()),
        });
        txHash = tx.transaction_hash;
      } else {
        throw new Error("No account connected");
      }

      console.log("⛓️ Payment tx hash:", txHash);
      await provider.waitForTransaction(txHash);

      const receipt: any = await provider.getTransactionReceipt(txHash);
      console.log("📄 Payment receipt:", receipt);
      if (receipt.execution_status !== 'SUCCEEDED') {
        throw new Error(`Payment verification failed: ${receipt.execution_status} - ${receipt.revert_reason || 'unknown'}`);
      }

      toast.dismiss();
      toast.success("✅ Payment proof verified on‑chain");
      setProofGeneratedLotes(prev => ({ ...prev, [selectedLotId]: true }));
      localStorage.setItem(`proof_tx_${selectedLotId}`, txHash);
    } catch (error: any) {
      console.error("❌ Payment verification error:", error);
      toast.dismiss();
      toast.error("Payment failed: " + error.message);
    } finally {
      setIsLoading(false);
    }
  };

  interface Bid {
    secret: string;
    amount: string;
    lot_id: string;
    winner: string;
    commitment: string;
  }

  interface BackendResponse {
    calldata: string[];
  }

  /**
   * Finalizes a lot using a dynamic ZK proof (owner only).
   */
  const handleFinalizeWithZK = async () => {
    console.log("🚀 handleFinalizeWithZK started");
    
    if (!contract || !activeAccountAddress || !selectedLotId || !selectedLotInfo) {
      console.log("❌ Missing data", { contract, activeAccountAddress, selectedLotId, selectedLotInfo });
      return;
    }
    if (!isOwner) {
      toast.error("Only the owner can finalize with ZK");
      return;
    }
    if (selectedLotInfo.finalizado) {
      toast.error("Lot already finalized");
      return;
    }

    setIsLoading(true);
    const startTime = Date.now();

    try {
      console.log("📦 Fetching bids from localStorage...");
      const allBids: Bid[] = JSON.parse(
        localStorage.getItem(`bids_${selectedLotId}`) || '[]'
      );
      console.log(`📦 Found ${allBids.length} bids`);
      if (allBids.length === 0) {
        toast.error("No bids in this lot");
        setIsLoading(false);
        return;
      }

      const BACKEND_URL = '/api/zk-proof';
      toast.loading("Generating ZK proof via backend...");
      console.log("🌐 Sending request to backend...");
      
      const response = await fetch(BACKEND_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bids: allBids }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Backend error (${response.status}): ${errorText}`);
      }

      const { calldata }: BackendResponse = await response.json();
      console.log("✅ Calldata received, length:", calldata.length);
      toast.dismiss();

      toast.loading("Verifying ZK proof on-chain...");
      console.log("⛓️ Sending verification transaction...");
      
      let txHash: string;
      if (isCavosAuth) {
        txHash = await cavosExecute({
          contractAddress: AUCTION_VERIFIER_ADDRESS,
          entrypoint: "verify_ultra_keccak_honk_proof",
          calldata: calldata.map(c => c.toString()),
        });
      } else if (walletAccount) {
        const tx = await walletAccount.execute({
          contractAddress: AUCTION_VERIFIER_ADDRESS,
          entrypoint: "verify_ultra_keccak_honk_proof",
          calldata: calldata.map(c => c.toString()),
        });
        txHash = tx.transaction_hash;
      } else {
        throw new Error("No account connected");
      }

      console.log("⛓️ Verification tx hash:", txHash);
      await provider.waitForTransaction(txHash);

      const receipt: any = await provider.getTransactionReceipt(txHash);
      console.log("📄 Verification receipt:", receipt);
      if (receipt.execution_status !== 'SUCCEEDED') {
        throw new Error(`Verification failed: ${receipt.execution_status} - ${receipt.revert_reason || 'unknown'}`);
      }
      
      toast.dismiss();
      toast.success("✅ ZK proof verified on‑chain (dynamic)");

      toast.loading("Waiting for finalization confirmation...");
      console.log("⛓️ Preparing finalize_lot...");
      const call = contract.populate("finalize_lot", [selectedLotId]);
      console.log("Call to execute:", call);

      let tx2;
      try {
        tx2 = await executeTransaction(call);
      } catch (execError: any) {
        console.error("❌ Error executing finalize_lot:", execError);
        throw new Error(`Error sending finalize_lot: ${execError.message}`);
      }

      console.log("⛓️ Finalization tx hash:", tx2.transaction_hash);
      await provider.waitForTransaction(tx2.transaction_hash);

      const receipt2: any = await provider.getTransactionReceipt(tx2.transaction_hash);
      console.log("📄 Finalization receipt:", receipt2);
      if (receipt2.execution_status !== 'SUCCEEDED') {
        throw new Error(`Finalize failed: ${receipt2.execution_status} - ${receipt2.revert_reason || 'unknown'}`);
      }

      console.log("🔄 Updating lot information...");
      const updatedInfo = await contract.get_lot_info(selectedLotId);
      const updatedLot = {
        id: selectedLotInfo.id,
        productor: toHexAddress(updatedInfo.productor),
        raza: updatedInfo.raza.toString(),
        peso_inicial: updatedInfo.peso_inicial?.toString() || "0",
        cantidad_animales: updatedInfo.cantidad_animales?.toString() || "0",
        metadata_uri: updatedInfo.metadata_uri?.toString() || "",
        start_time: Number(updatedInfo.start_time),
        duration: Number(updatedInfo.duration),
        finalizado: updatedInfo.finalizado,
        mejor_puja: updatedInfo.mejor_puja?.toString() || "0",
        mejor_postor: toHexAddress(updatedInfo.mejor_postor),
        metadata: selectedLotInfo.metadata,
      };
      console.log("✅ Lot updated:", updatedLot);
      setSelectedLotInfo(updatedLot);

      await fetchAllLots(true);
      setZkFinalizedLotes(prev => ({ ...prev, [selectedLotId]: true }));

      localStorage.setItem(`proof_tx_${selectedLotId}`, txHash);
      localStorage.setItem(`finalize_tx_${selectedLotId}`, tx2.transaction_hash);

      console.log(`✅ Process completed in ${(Date.now() - startTime) / 1000}s`);
      toast.dismiss();
      toast.success("✅ Lot finalized with dynamic ZK proof!");
    } catch (error: any) {
      console.error("❌ Error in finalizeWithZK:", error);
      toast.dismiss();
      toast.error("Failed: " + error.message);
    } finally {
      setIsLoading(false);
    }
  };

  if (!activeAccountAddress) {
    return (
      <div className="flex justify-center items-center min-h-screen">
        <p className="text-xl">Connect your wallet or login with Google to start</p>
      </div>
    );
  }

  const userHasParticipated = participatedLotes[selectedLotId];
  const hasGeneratedProof = proofGeneratedLotes[selectedLotId];

  const finalizeTxHash = selectedLotId ? localStorage.getItem(`finalize_tx_${selectedLotId}`) : null;

  return (
    <div className="container mx-auto p-4 md:p-8 max-w-7xl">
      <div className="text-center mb-8">
        <h1 className="text-4xl font-bold mb-2">🐂 ZK-Sealed Cattle</h1>
        <p className="text-xl text-gray-600 dark:text-gray-400">Zero-Knowledge Sealed-Bid Auction on Starknet</p>
        <div className="mt-2">
          <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200">
            Sepolia Testnet
          </span>
        </div>
      </div>

      {errorMessage && (
        <div className="alert alert-error mb-4">
          <span>{errorMessage}</span>
        </div>
      )}

      {isOwner && (
        <div className="card bg-base-100 shadow-xl p-6 mb-8">
          <h2 className="text-2xl font-semibold mb-4">➕ Create New Lot</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <input
              type="text"
              className="input input-bordered bg-gray-100"
              placeholder="Lot ID (auto)"
              value={nextLotId}
              readOnly
            />
            <input
              type="text"
              className="input input-bordered"
              placeholder="Producer address"
              value={newProductor}
              onChange={(e) => setNewProductor(e.target.value)}
            />
            <select
              className="select input-bordered"
              value={newRaza}
              onChange={(e) => setNewRaza(e.target.value)}
            >
              <option value="">Select breed</option>
              {RAZAS.map((raza, index) => (
                <option key={index} value={index}>
                  {raza}
                </option>
              ))}
            </select>
            <input
              type="number"
              className="input input-bordered"
              placeholder="Initial weight (kg)"
              value={newPeso}
              onChange={(e) => setNewPeso(e.target.value)}
              step="1"
            />
            <input
              type="number"
              className="input input-bordered"
              placeholder="Number of animals"
              value={newCantidad}
              onChange={(e) => setNewCantidad(e.target.value)}
              step="1"
            />
            <input
              type="text"
              className="input input-bordered md:col-span-2"
              placeholder="IPFS hash (without ipfs://)"
              value={newMetadataHash}
              onChange={(e) => setNewMetadataHash(e.target.value)}
            />
            <input
              type="number"
              className="input input-bordered"
              placeholder="Duration (seconds, e.g. 360000 for 100h)"
              value={newDuration}
              onChange={(e) => setNewDuration(e.target.value)}
              step="1"
            />
          </div>
          <button
            className="btn btn-primary w-full mt-4"
            onClick={handleCreateLot}
            disabled={
              isLoading ||
              !newProductor ||
              !newRaza ||
              !newPeso ||
              !newCantidad ||
              !newMetadataHash ||
              !newDuration
            }
          >
            {isLoading ? "Creating..." : "Create Lot"}
          </button>
        </div>
      )}

      <div className="card bg-base-100 shadow-xl p-6 mb-8">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-4">
          <h2 className="text-2xl font-semibold">📋 Available Lots</h2>
          <button
            className="btn btn-outline btn-sm"
            onClick={() => fetchAllLots(true)}
            disabled={loadingLots || refreshing}
          >
            {refreshing ? <span className="loading loading-spinner loading-xs"></span> : "↻ Refresh"}
          </button>
        </div>
        {loadingLots ? (
          <div className="flex justify-center items-center py-12">
            <span className="loading loading-spinner loading-lg"></span>
          </div>
        ) : lots.length === 0 ? (
          <p>No lots created yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table table-zebra w-full">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Producer</th>
                  <th>Breed</th>
                  <th>Weight (kg)</th>
                  <th>Animals</th>
                  <th className="hidden md:table-cell">Time Left</th>
                  <th className="hidden lg:table-cell">Best Bid</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {lots.map((lot) => {
                  const active = isAuctionActive(lot);
                  const razaNombre = getRazaNombre(lot.raza);
                  const esGanador =
                    lot.finalizado &&
                    normalizeAddress(lot.mejor_postor) === normalizeAddress(activeAccountAddress);
                  const proofGenerated = esGanador && proofGeneratedLotes[lot.id.toString()];
                  const zkFinalized = zkFinalizedLotes[lot.id.toString()];

                  return (
                    <tr
                      key={lot.id}
                      className={`hover:bg-base-300 cursor-pointer ${
                        selectedLotId === lot.id.toString() ? "bg-primary/20" : ""
                      }`}
                      onClick={() => handleSelectLot(lot)}
                    >
                      <td>{lot.id}</td>
                      <td className="tooltip tooltip-top" data-tip={lot.productor}>
                        {lot.productor && typeof lot.productor === "string"
                          ? lot.productor.slice(0, 6)
                          : "???"}
                        ...
                      </td>
                      <td>{razaNombre}</td>
                      <td>{lot.peso_inicial}</td>
                      <td>{lot.cantidad_animales}</td>
                      <td className="hidden md:table-cell">
                        {lot.finalizado ? "Finalized" : active ? getTimeRemaining(lot) : "Ended"}
                      </td>
                      <td className="hidden lg:table-cell">🔒</td>
                      <td>
                        {proofGenerated ? (
                          <span className="badge badge-success badge-sm md:badge-md">ZK Proof</span>
                        ) : esGanador ? (
                          <span className="badge badge-warning badge-sm md:badge-md">Pending</span>
                        ) : lot.finalizado ? (
                          zkFinalized ? (
                            <span className="badge badge-info badge-sm md:badge-md">ZK Finalized</span>
                          ) : (
                            <span className="badge badge-neutral badge-sm md:badge-md">Finalized</span>
                          )
                        ) : active ? (
                          <span className="badge badge-info badge-sm md:badge-md">Active</span>
                        ) : (
                          <span className="badge badge-ghost badge-sm md:badge-md">Ended</span>
                        )}
                      </td>
                      <td>
                        {active && !lot.finalizado && !participatedLotes[lot.id.toString()] ? (
                          <button
                            className="btn btn-xs md:btn-sm btn-primary"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleSelectLot(lot);
                            }}
                          >
                            Bid
                          </button>
                        ) : (
                          <button className="btn btn-xs md:btn-sm btn-ghost" disabled>
                            {lot.finalizado
                              ? "Finalized"
                              : participatedLotes[lot.id.toString()]
                              ? "Already bid"
                              : "Ended"}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {selectedLotInfo && (
        <div className="card bg-base-200 p-6 mb-8">
          <h3 className="text-xl font-semibold mb-4">💰 Lot #{selectedLotId}</h3>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6 p-4 bg-base-300 rounded-lg">
            <div>
              <strong>Producer:</strong>{" "}
              <span className="tooltip" data-tip={selectedLotInfo.productor}>
                {selectedLotInfo.productor?.slice(0, 10)}...
              </span>
            </div>
            <div>
              <strong>Breed:</strong> {getRazaNombre(selectedLotInfo.raza)}
            </div>
            <div>
              <strong>Initial weight:</strong> {selectedLotInfo.peso_inicial} kg
            </div>
            <div>
              <strong>Animals:</strong> {selectedLotInfo.cantidad_animales}
            </div>
            <div>
              <strong>Status:</strong>{" "}
              {selectedLotInfo.finalizado ? (
                zkFinalizedLotes[selectedLotId] ? "ZK Finalized" : "Finalized"
              ) : isAuctionActive(selectedLotInfo) ? (
                "Active"
              ) : (
                "Ended"
              )}
            </div>
            {!selectedLotInfo.finalizado && isAuctionActive(selectedLotInfo) && (
              <div>
                <strong>Time left:</strong> {getTimeRemaining(selectedLotInfo)}
              </div>
            )}
            <div>
              <strong>Best bid:</strong> 🔒 Hidden
            </div>
            {selectedLotInfo.finalizado && (
              <div>
                <strong>Winner:</strong>{" "}
                <span className="tooltip" data-tip={selectedLotInfo.mejor_postor}>
                  {selectedLotInfo.mejor_postor?.slice(0, 10)}...
                </span>
              </div>
            )}
            {selectedLotMetadata && (
              <>
                <div className="col-span-1 md:col-span-2">
                  <strong>Description:</strong> {selectedLotMetadata.descripcion}
                </div>
                {selectedLotMetadata.certificaciones && (
                  <div className="col-span-1 md:col-span-2">
                    <strong>Certifications:</strong> {selectedLotMetadata.certificaciones.join(", ")}
                  </div>
                )}
              </>
            )}
          </div>

          {isOwner && !selectedLotInfo.finalizado && (
            <button
              className="btn btn-success w-full mb-4"
              onClick={handleFinalizeWithZK}
              disabled={isLoading}
            >
              {isLoading ? "Finalizing with ZK..." : "🔐 Finalize with ZK (dynamic)"}
            </button>
          )}

          {userHasParticipated ? (
            <div className="alert alert-info mb-4">
              You have already placed a bid in this lot. You cannot bid again.
            </div>
          ) : isAuctionActive(selectedLotInfo) && !selectedLotInfo.finalizado ? (
            <div className="space-y-4">
              <input
                type="number"
                className="input input-bordered w-full"
                placeholder="Bid amount (integer)"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                step="1"
                disabled={committed}
              />

              <div className="flex gap-2">
                <input
                  type="text"
                  className="input input-bordered flex-1"
                  placeholder="Nonce (secret)"
                  value={nonce}
                  onChange={(e) => setNonce(e.target.value)}
                  disabled={committed}
                />
                {!committed && (
                  <button
                    className="btn btn-secondary"
                    onClick={() => setNonce(Math.floor(Math.random() * 1000000).toString())}
                  >
                    🎲
                  </button>
                )}
              </div>

              {calculatedCommitment && !committed && (
                <div className="alert alert-info text-xs break-all">
                  <strong>Commitment to send (micro‑starknet):</strong> {calculatedCommitment}
                </div>
              )}

              {commitment && committed && (
                <div className="alert alert-success text-xs break-all">
                  <strong>Commitment sent (Poseidon):</strong> {commitment}
                </div>
              )}

              <button
                className="btn btn-primary w-full"
                onClick={handleCommit}
                disabled={isLoading || !amount || committed}
              >
                {isLoading ? "Sending..." : "1. Send Commit"}
              </button>

              <input
                type="text"
                className="input input-bordered w-full bg-gray-100"
                placeholder="Nonce (reveal)"
                value={nonce}
                readOnly
                disabled={!committed}
              />

              <button
                className="btn btn-secondary w-full"
                onClick={handleReveal}
                disabled={isLoading || !amount || !committed || revealed}
              >
                {isLoading ? "Sending..." : "2. Reveal Bid"}
              </button>
            </div>
          ) : !isAuctionActive(selectedLotInfo) && !selectedLotInfo.finalizado ? (
            <div className="alert alert-warning">
              Bidding time has expired. Wait for the owner to finalize the auction.
            </div>
          ) : null}

          {/* ZK proof button – only for winner if not generated */}
          {selectedLotInfo.finalizado &&
            normalizeAddress(selectedLotInfo.mejor_postor) === normalizeAddress(activeAccountAddress) &&
            !hasGeneratedProof && (
              <button
                className="btn btn-primary w-full mt-4"
                onClick={handleZKProof}
                disabled={isLoading}
              >
                {isLoading ? "Generating..." : "🔐 Pay with ZK (Private Payment)"}
              </button>
            )}

          {/* Proof generated message with link to Voyager (for winner) */}
          {selectedLotInfo.finalizado &&
            normalizeAddress(selectedLotInfo.mejor_postor) === normalizeAddress(activeAccountAddress) &&
            hasGeneratedProof && (
              <div className="alert alert-success mt-4">
                ✅ Payment verified on‑chain.{" "}
                <a
                  href={`https://sepolia.voyager.online/tx/${localStorage.getItem(`proof_tx_${selectedLotId}`)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline text-blue-600 hover:text-blue-800"
                >
                  {localStorage.getItem(`proof_tx_${selectedLotId}`)?.slice(0, 10)}...
                </a>
              </div>
            )}

          {/* Finalization transaction link for the owner */}
          {isOwner && finalizeTxHash && (
            <div className="alert alert-info mt-4">
              ✅ Lot finalized on‑chain.{" "}
              <a
                href={`https://sepolia.voyager.online/tx/${finalizeTxHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline text-blue-600 hover:text-blue-800"
              >
                {finalizeTxHash.slice(0, 10)}...
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}