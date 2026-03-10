/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

/**
 * Main auction page component.
 * Handles lot creation, bidding (commit/reveal), ZK finalization, and ZK payment.
 * Integrates Cavos for social login and uses a backend proof service.
 */

import { useAccount, useContract, useProvider } from "@starknet-react/core";
import { useState, useMemo, useEffect, useCallback, useRef } from "react";
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

// IPFS Gateway configuration from environment variables
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
 * Accepts any type and converts to string first.
 * @param addr - Raw address value
 * @returns Normalized address string
 */
function normalizeAddress(addr: any): string {
  if (!addr) return "";
  const addrStr = String(addr);
  const hex = addrStr.replace("0x", "").replace(/^0+/, "");
  return "0x" + (hex || "0");
}

// Verifier addresses from environment variables (used for direct calls, but now we call the main contract)
const VERIFIER_ADDRESS = process.env.NEXT_PUBLIC_PAYMENT_VERIFIER_ADDRESS || '';
const AUCTION_VERIFIER_ADDRESS = process.env.NEXT_PUBLIC_AUCTION_VERIFIER_ADDRESS || '';

export default function Home() {
  const { account: walletAccount } = useAccount();
  const { contract } = useContract({
    abi: contractData?.abi,
    address: contractData?.address,
  });
  const { provider } = useProvider();

  // Cavos social login hooks
  const { 
    address: cavosAddress, 
    isAuthenticated: isCavosAuth, 
    execute: cavosExecute,
    logout: cavosLogout,
    walletStatus,
    registerCurrentSession,
    updateSessionPolicy
  } = useCavos();

  // Unified active account: Cavos takes precedence if authenticated
  const activeAccount = isCavosAuth ? cavosAddress : walletAccount;
  const activeAccountAddress = isCavosAuth ? cavosAddress : walletAccount?.address;

  // Use a ref to keep a stable contract reference (avoid re‑effects)
  const contractRef = useRef(contract);
  useEffect(() => {
    contractRef.current = contract;
  }, [contract]);

  /**
   * Unified transaction execution function.
   * For Cavos, it includes a retry mechanism that auto‑registers the session if needed.
   * @param call - Transaction call object
   * @returns Object containing transaction hash
   */
  const executeTransaction = async (call: any) => {
    if (isCavosAuth) {
      const executeWithRetry = async (): Promise<{ transaction_hash: string }> => {
        try {
          const txHash = await cavosExecute(call);
          return { transaction_hash: txHash };
        } catch (error: any) {
          if (error.message?.includes('Session not registered')) {
            console.log("⚠️ Session not registered, attempting to register now...");
            toast.loading('Updating policy and registering session...', { id: 'auto-activate' });

            try {
              if (updateSessionPolicy) {
                updateSessionPolicy({
                  allowedContracts: [
                    process.env.NEXT_PUBLIC_AUCTION_CONTRACT_ADDRESS || '',
                  ],
                  spendingLimits: [
                    {
                      token: process.env.NEXT_PUBLIC_STRK_TOKEN_ADDRESS || '',
                      limit: BigInt(1000) * BigInt(10 ** 18),
                    },
                  ],
                  maxCallsPerTx: 10,
                });
              }

              await registerCurrentSession();
              toast.success('Session activated!', { id: 'auto-activate' });

              const txHash = await cavosExecute(call);
              return { transaction_hash: txHash };
            } catch (regError: any) {
              toast.error('Auto-activation failed: ' + regError.message, { id: 'auto-activate' });
              toast.error('Please use the "Activate" button next to your address and try again.', { id: 'manual-suggest' });
              throw new Error(`Failed to activate session: ${regError.message}`);
            }
          }
          throw error;
        }
      };
      return await executeWithRetry();
    } else if (walletAccount) {
      const tx = await walletAccount.execute([call]);
      return tx;
    } else {
      throw new Error("No account connected");
    }
  };

  const [owner, setOwner] = useState<string | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const DEFAULT_PRODUCER = "0x0626bb9241ba6334ae978cfce1280d725e727a6acb5e61392ab4cee031a4b7ca";

  // Form fields for lot creation
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

  // Bidding state
  const [amount, setAmount] = useState("");
  const [nonce, setNonce] = useState(Math.floor(Math.random() * 1000000).toString());
  const [isLoading, setIsLoading] = useState(false);
  const [committed, setCommitted] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [commitment, setCommitment] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  // Per‑account persistent states (partially from localStorage)
  const [participatedLotes, setParticipatedLotes] = useState<Record<string, boolean>>({});
  const [proofGeneratedLotes, setProofGeneratedLotes] = useState<Record<string, boolean>>({});
  const [zkFinalizedLotes, setZkFinalizedLotes] = useState<Record<string, boolean>>({});
  const [debugData, setDebugData] = useState<any>(null);

  // ---------- Helper function: check if a user has already bid in a lot (on‑chain) ----------
  const checkIfUserParticipated = useCallback(async (lotId: string, userAddress: string): Promise<boolean> => {
    if (!contractRef.current || !userAddress) return false;
    try {
      const count = await contractRef.current.get_bidders_count(lotId);
      const countNum = Number(count);
      const userHex = toHexAddress(userAddress).toLowerCase();
      for (let i = 0; i < countNum; i++) {
        const bidder = await contractRef.current.get_bidder_at(lotId, i);
        const bidderHex = toHexAddress(bidder).toLowerCase();
        if (bidderHex === userHex) {
          return true;
        }
      }
      return false;
    } catch (error) {
      console.error("Error checking participation:", error);
      return false;
    }
  }, []); // No dependencies: uses contractRef

  // ---------- Effect: verify participation and restore committed from localStorage ----------
  useEffect(() => {
    if (!activeAccountAddress || !selectedLotId) return;
    const verifyAndRestore = async () => {
      const participated = await checkIfUserParticipated(selectedLotId, activeAccountAddress);
      setParticipatedLotes(prev => ({ ...prev, [selectedLotId]: participated }));

      const winnerAddrFormatted = toHexAddress(activeAccountAddress).toLowerCase();
      const key = `zk_${selectedLotId}_${winnerAddrFormatted}`;
      const storedData = localStorage.getItem(key);
      // Restore committed only if the account really participated on‑chain
      if (storedData && participated) {
        const bid = JSON.parse(storedData);
        setCommitted(true);
        setAmount(bid.amount);
        setNonce(bid.secret);
        setCommitment(bid.commitment);
      } else {
        setCommitted(false);
        setAmount("");
        setNonce(Math.floor(Math.random() * 1000000).toString());
        setCommitment("");
      }
    };
    verifyAndRestore();
  }, [activeAccountAddress, selectedLotId, checkIfUserParticipated]);

  // ---------- Effect: clear all account‑specific states when switching accounts ----------
  useEffect(() => {
    setParticipatedLotes({});
    setCommitted(false);
    setRevealed(false);
    setCommitment("");
    setAmount("");
    setNonce(Math.floor(Math.random() * 1000000).toString());
  }, [activeAccountAddress]);

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
   * Computes the commitment preview for the UI (only before commit).
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

  // Load per‑account data from localStorage for proofGenerated and zkFinalized (these are less critical)
  useEffect(() => {
    if (!activeAccountAddress) {
      setProofGeneratedLotes({});
      setZkFinalizedLotes({});
      return;
    }
    const accountKey = activeAccountAddress.toLowerCase();

    const savedProofGenerated = localStorage.getItem(`proofGeneratedLotes_${accountKey}`);
    setProofGeneratedLotes(savedProofGenerated ? JSON.parse(savedProofGenerated) : {});

    const savedZkFinalized = localStorage.getItem(`zkFinalizedLotes_${accountKey}`);
    setZkFinalizedLotes(savedZkFinalized ? JSON.parse(savedZkFinalized) : {});
  }, [activeAccountAddress]);

  // Save per‑account data (only proofGenerated and zkFinalized)
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

  // Clock for auction countdown
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Owner check: compare active account with configured owner address
  useEffect(() => {
    if (activeAccountAddress) {
      const ownerAddress = (process.env.NEXT_PUBLIC_OWNER_ADDRESS || DEFAULT_PRODUCER).toLowerCase();
      setOwner(ownerAddress);
      const normalizedAccount = toHexAddress(activeAccountAddress).toLowerCase();
      const normalizedOwner = toHexAddress(ownerAddress).toLowerCase();
      setIsOwner(normalizedAccount === normalizedOwner);
    } else {
      setIsOwner(false);
    }
  }, [activeAccountAddress]);

  // ---------- Fetch all lots from contract, including participation, payment status, and winner record ----------
  const fetchAllLots = useCallback(async (showRefreshing = false) => {
    if (!contractRef.current) return;
    if (showRefreshing) setRefreshing(true);
    else setLoadingLots(true);
    try {
      const count = await contractRef.current.get_lot_count();
      const num = Number(count);
      setNextLotId(String(num + 1));

      const lotsArray = [];
      const participationPromises = [];

      for (let i = 1; i <= num; i++) {
        try {
          const info = await contractRef.current.get_lot_info(i);
          let metadata = null;
          const metadataUri = info.metadata_uri ? info.metadata_uri.toString() : "";

          if (metadataUri.startsWith("ipfs://")) {
            const cid = metadataUri.replace("ipfs://", "");
            const gatewayUrl = `${IPFS_GATEWAY}/ipfs/${cid}`;
            try {
              const res = await fetch(gatewayUrl);
              if (res.ok) metadata = await res.json();
            } catch {
              // ignore
            }
          }

          const productorHex = toHexAddress(info.productor);
          const mejorPostorHex = toHexAddress(info.mejor_postor);
          
          let paymentDone = false;
          let winnerRecord = null;

          if (info.finalizado) {
            try {
              paymentDone = await contractRef.current.is_payment_done(i);
            } catch (e) {
              console.error(`Error checking payment status for lot ${i}:`, e);
            }
            // Fetch winner record for finalized lots (only once)
            try {
              const winnerData = await contractRef.current.get_winner(i);
              if (winnerData && winnerData[0] && winnerData[1] !== undefined) {
                winnerRecord = {
                  address: toHexAddress(winnerData[0]),
                  amount: winnerData[1].toString(),
                };
              }
            } catch (e) {
              console.error(`Error fetching winner for lot ${i}:`, e);
            }
          }

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
            paymentDone,
            winnerRecord, // stored directly in the lot object
          });

          if (activeAccountAddress) {
            participationPromises.push(
              checkIfUserParticipated(i.toString(), activeAccountAddress)
                .then(participated => ({ lotId: i.toString(), participated }))
                .catch(() => ({ lotId: i.toString(), participated: false }))
            );
          }
        } catch (e) {
          console.error(`Error fetching lot ${i}:`, e);
        }
      }

      setLots(lotsArray);

      if (activeAccountAddress && participationPromises.length > 0) {
        const results = await Promise.all(participationPromises);
        const newParticipated: Record<string, boolean> = {};
        results.forEach(({ lotId, participated }) => {
          newParticipated[lotId] = participated;
        });
        setParticipatedLotes(newParticipated);
      }
    } catch (e) {
      console.error("Error in fetchAllLots:", e);
      toast.error("Failed to load lots");
    } finally {
      setLoadingLots(false);
      setRefreshing(false);
    }
  }, [activeAccountAddress, checkIfUserParticipated]);

  useEffect(() => {
    fetchAllLots();
  }, [fetchAllLots, activeAccountAddress]);

  /**
   * Handles selection of a lot.
   * @param lot - The lot object
   */
  const handleSelectLot = (lot: any) => {
    setSelectedLotId(lot.id.toString());
    setSelectedLotInfo(lot);
    setSelectedLotMetadata(lot.metadata);
    setDebugData(null);
    setRevealed(false); // reset reveal status (will be restored by effect if needed)
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
    if (!contractRef.current || !activeAccount) return;
    if (!isOwner) {
      setErrorMessage("❌ Only the owner can create lots");
      return;
    }
    setIsLoading(true);
    try {
      const metadataUri = newMetadataHash.startsWith("ipfs://") 
        ? newMetadataHash 
        : `ipfs://${newMetadataHash}`;

      const call = contractRef.current.populate("create_lot", [
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
    if (!contractRef.current || !activeAccountAddress || !selectedLotId) return;
    if (!isAuctionActive(selectedLotInfo)) {
      toast.error("❌ Auction is not active");
      return;
    }

    setIsLoading(true);

    const waitForSessionReady = async (timeout = 15000): Promise<boolean> => {
      if (!isCavosAuth) return true;
      const start = Date.now();
      while (Date.now() - start < timeout) {
        if (walletStatus?.isReady) {
          console.log("✅ Session ready after", Date.now() - start, "ms");
          return true;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      return false;
    };

    try {
      if (isCavosAuth) {
        const ready = await waitForSessionReady();
        if (!ready) {
          toast.loading("Activating session on‑chain...", { id: 'session-act' });
          try {
            await registerCurrentSession();
            toast.dismiss('session-act');
            const readyAfterReg = await waitForSessionReady(5000);
            if (!readyAfterReg) {
              throw new Error("Session still not ready after registration");
            }
          } catch (regError: any) {
            toast.dismiss('session-act');
            throw new Error(`Failed to activate session: ${regError.message}`);
          }
        }
      }

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

      const call = contractRef.current.populate("commit_bid", [selectedLotId, poseidonCommitment]);
      const tx = await executeTransaction(call);
      await provider.waitForTransaction(tx.transaction_hash);

      const receipt: any = await provider.getTransactionReceipt(tx.transaction_hash);
      if (receipt.execution_status !== 'SUCCEEDED') {
        throw new Error(`Commit transaction failed: ${receipt.execution_status} - ${receipt.revert_reason || 'unknown'}`);
      }

      setCommitment(poseidonCommitment);
      setCommitted(true);
      const participated = await checkIfUserParticipated(selectedLotId, activeAccountAddress);
      setParticipatedLotes(prev => ({ ...prev, [selectedLotId]: participated }));
      toast.success("✅ Commit successful. Now reveal.");
    } catch (e: any) {
      console.error("Error in commit:", e);
      toast.error("❌ Commit failed: " + (e.message || JSON.stringify(e)));
      setCommitted(false);
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Reveals a previously committed bid.
   */
  const handleReveal = async () => {
    setErrorMessage("");
    if (!contractRef.current || !activeAccountAddress || !selectedLotId) return;
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
        contractAddress: contractRef.current.address,
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

      const receipt: any = await provider.getTransactionReceipt(txHash);
      if (receipt.execution_status !== 'SUCCEEDED') {
        throw new Error(`Reveal transaction failed: ${receipt.execution_status} - ${receipt.revert_reason || 'unknown'}`);
      }

      localStorage.removeItem(key); // data no longer needed after successful reveal

      toast.success("✅ Bid revealed");

      const updatedInfo = await contractRef.current.get_lot_info(selectedLotId);
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
      
      if (e.message?.includes("Commitment mismatch") || e.message?.includes("commitment")) {
        try {
          const winnerAddrFormatted = toHexAddress(activeAccountAddress).toLowerCase();
          const key = `zk_${selectedLotId}_${winnerAddrFormatted}`;
          const storedData = localStorage.getItem(key);
          if (storedData) {
            const bid = JSON.parse(storedData);
            const debugResult = await contractRef.current.debug_reveal(selectedLotId, bid.amount, bid.secret);
            console.log("🔍 DEBUG REVEAL DATA:", debugResult);
            
            const [computed, stored, accountAddress, caller] = debugResult;
            const debugInfo = {
              computed: computed.toString(),
              stored: stored.toString(),
              accountAddress: toHexAddress(accountAddress),
              caller: toHexAddress(caller),
              lotId: selectedLotId,
              amount: bid.amount,
              nonce: bid.secret
            };
            setDebugData(debugInfo);
            
            toast.error(
              <div className="text-xs">
                <p>❌ Commitment mismatch</p>
                <p>Computed: {debugInfo.computed.slice(0, 10)}...</p>
                <p>Stored: {debugInfo.stored.slice(0, 10)}...</p>
                <p>Account: {debugInfo.accountAddress.slice(0, 10)}...</p>
                <p>Caller: {debugInfo.caller.slice(0, 10)}...</p>
                <p>Check console for full details</p>
              </div>,
              { duration: 10000 }
            );
          } else {
            console.error("No stored data for debug");
          }
        } catch (debugErr) {
          console.error("Failed to get debug info:", debugErr);
        }
      }
      
      toast.error("❌ Reveal failed: " + (e.message || JSON.stringify(e)));
      setRevealed(false);
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Manual debug function to call debug_reveal for troubleshooting.
   */
  const handleDebugReveal = async () => {
    if (!contractRef.current || !selectedLotId || !amount || !nonce) {
      toast.error("Missing data for debug");
      return;
    }
    try {
      toast.loading("Calling debug_reveal...");
      const debugResult = await contractRef.current.debug_reveal(selectedLotId, amount, nonce);
      const [computed, stored, accountAddress, caller] = debugResult;
      const debugInfo = {
        computed: computed.toString(),
        stored: stored.toString(),
        accountAddress: toHexAddress(accountAddress),
        caller: toHexAddress(caller),
        lotId: selectedLotId,
        amount,
        nonce
      };
      setDebugData(debugInfo);
      console.log("🔍 MANUAL DEBUG REVEAL DATA:", debugInfo);
      toast.dismiss();
      toast.success("Debug data obtained (see console)");
      
      const message = `
Computed: ${debugInfo.computed}
Stored: ${debugInfo.stored}
Account: ${debugInfo.accountAddress}
Caller: ${debugInfo.caller}
      `;
      toast.custom(
        <div className="bg-gray-800 text-white p-4 rounded-lg max-w-md overflow-auto text-xs">
          <pre>{message}</pre>
          <button 
            className="mt-2 btn btn-sm btn-primary"
            onClick={() => navigator.clipboard.writeText(JSON.stringify(debugInfo, null, 2))}
          >
            Copy to clipboard
          </button>
        </div>,
        { duration: 15000 }
      );
    } catch (error) {
      console.error("Debug error:", error);
      toast.error("Debug failed");
    }
  };

  /**
   * ZK payment verification.
   * Fetches the winning bid from localStorage, generates proof via backend,
   * and calls verify_payment on the main contract.
   */
  const handleZKProof = async () => {
    if (!activeAccountAddress || !selectedLotInfo || !selectedLotInfo.finalizado) return;
    if (normalizeAddress(selectedLotInfo.mejor_postor) !== normalizeAddress(activeAccountAddress)) {
      toast.error("Only the winner can generate the ZK proof");
      return;
    }

    const allBids: Bid[] = JSON.parse(
      localStorage.getItem(`bids_${selectedLotId}`) || '[]'
    );
    if (allBids.length === 0) {
      toast.error("No bids found for this lot");
      return;
    }

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

      toast.loading("Verifying payment on contract...");
      console.log("⛓️ Calling verify_payment...");

      const call = contractRef.current.populate("verify_payment", [
        selectedLotId,
        calldata.map(c => c.toString())
      ]);

      let txHash: string;
      if (isCavosAuth) {
        txHash = await cavosExecute(call);
      } else if (walletAccount) {
        const tx = await walletAccount.execute([call]);
        txHash = tx.transaction_hash;
      } else {
        throw new Error("No account connected");
      }

      console.log("⛓️ verify_payment tx hash:", txHash);
      await provider.waitForTransaction(txHash);

      const receipt: any = await provider.getTransactionReceipt(txHash);
      console.log("📄 verify_payment receipt:", receipt);
      if (receipt.execution_status !== 'SUCCEEDED') {
        throw new Error(`verify_payment failed: ${receipt.execution_status} - ${receipt.revert_reason || 'unknown'}`);
      }

      toast.dismiss();
      toast.success("✅ Payment verified on‑chain");
      setProofGeneratedLotes(prev => ({ ...prev, [selectedLotId]: true }));
      localStorage.setItem(`proof_tx_${selectedLotId}`, txHash);

      const paymentDone = await contractRef.current.is_payment_done(selectedLotId);
      console.log("Payment done status:", paymentDone);
      
      await fetchAllLots(true);
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
   * Calls finalize_with_zk on the main contract.
   */

  const handleFinalizeWithZK = async () => {
    console.log("🚀 handleFinalizeWithZK started");
    
    if (!contractRef.current || !activeAccountAddress || !selectedLotId || !selectedLotInfo) {
      console.log("❌ Missing data", { contractRef, activeAccountAddress, selectedLotId, selectedLotInfo });
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
      // 1. Obtener los bids revelados directamente del contrato (nueva función)
      console.log("📦 Fetching revealed bids from contract for lot", selectedLotId);
      const revealedBids = await contractRef.current.get_revealed_bids(selectedLotId);
      
      if (!revealedBids || revealedBids.length === 0) {
        toast.error("No revealed bids in this lot");
        setIsLoading(false);
        return;
      }

      // Convertir a formato Bid (similar al que espera el backend)
      const allBids: Bid[] = revealedBids.map((bid: any) => ({
        secret: bid[2].toString(), // nonce
        amount: bid[1].toString(),  // amount
        lot_id: selectedLotId,
        winner: toHexAddress(bid[0]), // bidder
        commitment: '', // No es necesario para el circuito de selección
      }));

      console.log(`📦 Found ${allBids.length} bids from contract`);

      // 2. Llamar al backend para generar la prueba ZK
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

      // 3. Obtener la información más reciente del lote (ganador actual)
      const latestInfo = await contractRef.current.get_lot_info(selectedLotId);
      const winner = latestInfo.mejor_postor;
      const winnerAmount = latestInfo.mejor_puja?.toString() || "0";

      if (!winner || winner === '0x0' || winnerAmount === '0') {
        throw new Error("No winner determined yet");
      }

      console.log("🏆 Winner from contract:", { winner: toHexAddress(winner), winnerAmount });

      // 4. Enviar la transacción de finalización con ZK
      toast.loading("Submitting ZK proof to contract...");
      console.log("⛓️ Calling finalize_with_zk...");
      
      const call = contractRef.current.populate("finalize_with_zk", [
        selectedLotId,
        winner,
        winnerAmount,
        calldata.map(c => c.toString())
      ]);

      let txHash: string;
      if (isCavosAuth) {
        txHash = await cavosExecute(call);
      } else if (walletAccount) {
        const tx = await walletAccount.execute([call]);
        txHash = tx.transaction_hash;
      } else {
        throw new Error("No account connected");
      }

      console.log("⛓️ finalize_with_zk tx hash:", txHash);
      await provider.waitForTransaction(txHash);

      const receipt: any = await provider.getTransactionReceipt(txHash);
      console.log("📄 finalize_with_zk receipt:", receipt);
      if (receipt.execution_status !== 'SUCCEEDED') {
        throw new Error(`finalize_with_zk failed: ${receipt.execution_status} - ${receipt.revert_reason || 'unknown'}`);
      }

      toast.dismiss();
      toast.success("✅ Lot finalized with ZK proof!");

      // 5. Actualizar el estado local
      const updatedInfo = await contractRef.current.get_lot_info(selectedLotId);
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
        paymentDone: false,
      };
      setSelectedLotInfo(updatedLot);

      const winnerRecord = await contractRef.current.get_winner(selectedLotId);
      console.log("Winner record:", winnerRecord);

      await fetchAllLots(true);
      setZkFinalizedLotes(prev => ({ ...prev, [selectedLotId]: true }));

      localStorage.setItem(`finalize_tx_${selectedLotId}`, txHash);

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
              className="input input-bordered"  // Se eliminó la clase bg-gray-100
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
                    toHexAddress(lot.mejor_postor).toLowerCase() === toHexAddress(activeAccountAddress).toLowerCase();
                  const proofGenerated = esGanador && proofGeneratedLotes[lot.id.toString()];
                  const zkFinalized = zkFinalizedLotes[lot.id.toString()];
                  const paid = lot.paymentDone;

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
                        {paid ? (
                          <span className="badge badge-success badge-sm md:badge-md">Paid</span>
                        ) : proofGenerated ? (
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

          {/* Display winner record from lot object (already fetched) */}
          {selectedLotInfo.winnerRecord && (
            <div className="text-sm mt-2">
              <strong>Registered winner:</strong>{" "}
              <span className="tooltip" data-tip={selectedLotInfo.winnerRecord.address}>
                {selectedLotInfo.winnerRecord.address.slice(0, 10)}... ({selectedLotInfo.winnerRecord.amount} USD)
              </span>
            </div>
          )}

          {isOwner && !selectedLotInfo.finalizado && (
            <button
              className="btn btn-success w-full mb-4"
              onClick={handleFinalizeWithZK}
              disabled={isLoading}
            >
              {isLoading ? "Finalizing with ZK..." : "🔐 Finalize with ZK (dynamic)"}
            </button>
          )}

          {isAuctionActive(selectedLotInfo) && !selectedLotInfo.finalizado ? (
            <>
              {!committed ? (
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
                </div>
              ) : !revealed ? (
                <div className="space-y-4">
                  <input
                    type="text"
                    className="input input-bordered w-full"
                    placeholder="Nonce (reveal)"
                    value={nonce}
                    readOnly
                    disabled
                  />

                  <button
                    className="btn btn-secondary w-full"
                    onClick={handleReveal}
                    disabled={isLoading}
                  >
                    {isLoading ? "Revealing..." : "2. Reveal Bid"}
                  </button>

                  {committed && !revealed && (
                    <button
                      className="btn btn-ghost btn-sm w-full mt-2"
                      onClick={handleDebugReveal}
                      disabled={isLoading}
                    >
                      🔍 Debug Reveal (check commitment)
                    </button>
                  )}
                </div>
              ) : (
                <div className="alert alert-info mb-4">
                  You have already revealed your bid. Wait for the auction to end.
                </div>
              )}
            </>
          ) : !isAuctionActive(selectedLotInfo) && !selectedLotInfo.finalizado ? (
            <div className="alert alert-warning">
              Bidding time has expired. Wait for the owner to finalize the auction.
            </div>
          ) : null}

          {debugData && (
            <div className="alert alert-info mt-4 overflow-auto max-h-64 text-xs">
              <strong>Debug Data:</strong>
              <pre className="mt-2">{JSON.stringify(debugData, null, 2)}</pre>
              <button
                className="btn btn-xs btn-primary mt-2"
                onClick={() => navigator.clipboard.writeText(JSON.stringify(debugData, null, 2))}
              >
                Copy to clipboard
              </button>
            </div>
          )}

          {selectedLotInfo.finalizado &&
            normalizeAddress(selectedLotInfo.mejor_postor) === normalizeAddress(activeAccountAddress) &&
            !hasGeneratedProof && !selectedLotInfo.paymentDone && (
              <button
                className="btn btn-primary w-full mt-4"
                onClick={handleZKProof}
                disabled={isLoading}
              >
                {isLoading ? "Generating..." : "🔐 Pay with ZK (Private Payment)"}
              </button>
            )}

          {selectedLotInfo.finalizado &&
            normalizeAddress(selectedLotInfo.mejor_postor) === normalizeAddress(activeAccountAddress) &&
            hasGeneratedProof && !selectedLotInfo.paymentDone && (
              <div className="alert alert-success mt-4">
                ✅ Payment proof generated, waiting for confirmation? This may take a moment.
              </div>
            )}

          {selectedLotInfo.paymentDone && (
            <div className="alert alert-success mt-4">
              ✅ Payment verified on‑chain.
            </div>
          )}

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