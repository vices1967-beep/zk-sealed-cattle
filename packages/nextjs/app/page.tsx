"use client";

import { useAccount, useContract, useProvider } from "@starknet-react/core";
import { useState, useMemo, useEffect } from "react";
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

function toHexAddress(addr: any): string {
  if (!addr) return "0x0";
  try {
    const big = BigInt(addr);
    return "0x" + big.toString(16).padStart(64, "0");
  } catch {
    return String(addr);
  }
}

function normalizeAddress(addr: string): string {
  if (!addr) return "";
  const hex = addr.replace("0x", "").replace(/^0+/, "");
  return "0x" + (hex || "0");
}

// Payment verifier address (deployed)
const VERIFIER_ADDRESS = "0x07b31788d2d06f1b80696f38ba7224f3595cc482dbd2f816165dbc7cdf476c14";
// Selection verifier address (deployed)
const AUCTION_VERIFIER_ADDRESS = "0x05c76e04b1384953264c98d5dc1f5b69d44e2cb6086567fe7944c62b08b58080";

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

  // Unificar cuenta activa: prioridad a Cavos si está autenticado
  const activeAccount = isCavosAuth ? cavosAddress : walletAccount;
  const activeAccountAddress = isCavosAuth ? cavosAddress : walletAccount?.address;

  // Función unificada para ejecutar transacciones
  const executeTransaction = async (call: any) => {
    if (isCavosAuth) {
      // Cavos: usa cavosExecute y devuelve hash
      const txHash = await cavosExecute(call);
      return { transaction_hash: txHash };
    } else if (walletAccount) {
      // Wallet tradicional: usa account.execute y devuelve objeto con hash
      const tx = await walletAccount.execute([call]);
      return tx;
    } else {
      throw new Error("No account connected");
    }
  };

  const [owner, setOwner] = useState<string | null>(null);
  const [isOwner, setIsOwner] = useState(false);

  const [newProductor, setNewProductor] = useState("");
  const [newRaza, setNewRaza] = useState("");
  const [newPeso, setNewPeso] = useState("");
  const [newCantidad, setNewCantidad] = useState("");
  const [newMetadata, setNewMetadata] = useState("");
  const [newDuration, setNewDuration] = useState("3600");
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

  const [paidLotes, setPaidLotes] = useState<Record<string, boolean>>({});
  const [participatedLotes, setParticipatedLotes] = useState<Record<string, boolean>>({});
  const [proofGeneratedLotes, setProofGeneratedLotes] = useState<Record<string, boolean>>({});
  const [zkFinalizedLotes, setZkFinalizedLotes] = useState<Record<string, boolean>>({});

  const [calldataPago, setCalldataPago] = useState<string[]>([]);
  const [calldataSeleccion, setCalldataSeleccion] = useState<string[]>([]);

  // Cargar calldata de pago (fijo)
  useEffect(() => {
    const loadCalldataPago = async () => {
      try {
        const response = await fetch("/calldata_real.txt");
        const text = await response.text();
        const numbers = text.trim().split(/\s+/);
        setCalldataPago(numbers);
      } catch (error) {
        console.error("Failed to load calldata for payment:", error);
        toast.error("Failed to load payment calldata");
      }
    };
    loadCalldataPago();
  }, []);

  // Cargar calldata de selección según el lote seleccionado
  useEffect(() => {
    if (!selectedLotId) {
      setCalldataSeleccion([]);
      return;
    }
    const loadCalldataSeleccion = async () => {
      try {
        const response = await fetch(`/calldata_lote${selectedLotId}.txt`);
        if (!response.ok) {
          setCalldataSeleccion([]);
          return;
        }
        const text = await response.text();
        const numbers = text.trim().split(/\s+/);
        setCalldataSeleccion(numbers);
      } catch (error) {
        console.error(`Failed to load calldata for lot ${selectedLotId}:`, error);
        setCalldataSeleccion([]);
      }
    };
    loadCalldataSeleccion();
  }, [selectedLotId]);

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
      setPaidLotes({});
      setParticipatedLotes({});
      setProofGeneratedLotes({});
      setZkFinalizedLotes({});
      return;
    }
    const accountKey = activeAccountAddress.toLowerCase();

    const savedPaid = localStorage.getItem(`paidLotes_${accountKey}`);
    setPaidLotes(savedPaid ? JSON.parse(savedPaid) : {});

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
    localStorage.setItem(`paidLotes_${accountKey}`, JSON.stringify(paidLotes));
  }, [paidLotes, activeAccountAddress]);

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
      const ownerAddress = "0x0626bb9241ba6334ae978cfce1280d725e727a6acb5e61392ab4cee031a4b7ca".toLowerCase();
      setOwner(ownerAddress);
      const normalizedAccount = normalizeAddress(activeAccountAddress);
      const normalizedOwner = normalizeAddress(ownerAddress);
      setIsOwner(normalizedAccount === normalizedOwner);
    } else {
      setIsOwner(false);
    }
  }, [activeAccountAddress]);

  // Fetch all lots from contract
  const fetchAllLots = async (showRefreshing = false) => {
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
            const gatewayUrl = `https://gateway.pinata.cloud/ipfs/${cid}`;
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
  };

  useEffect(() => {
    fetchAllLots();
  }, [contract, activeAccountAddress]); // depende de la dirección de la cuenta

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

  const isAuctionActive = (lot: any) => {
    if (!lot) return false;
    if (lot.finalizado) return false;
    const endTime = lot.start_time + lot.duration;
    return currentTime < endTime;
  };

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

  const getRazaNombre = (razaIndex: string) => {
    const index = parseInt(razaIndex, 10);
    return !isNaN(index) && RAZAS[index] ? RAZAS[index] : razaIndex;
  };

  const splitU256 = (value: bigint) => {
    const mask = (1n << 128n) - 1n;
    const low = value & mask;
    const high = value >> 128n;
    return { low, high };
  };

  const handleCreateLot = async () => {
    setErrorMessage("");
    if (!contract || !activeAccount) return;
    if (!isOwner) {
      setErrorMessage("❌ Only the owner can create lots");
      return;
    }
    setIsLoading(true);
    try {
      const call = contract.populate("create_lot", [
        BigInt(nextLotId),
        newProductor,
        newRaza,
        BigInt(newPeso),
        BigInt(newCantidad),
        newMetadata,
        BigInt(newDuration),
      ]);
      const tx = await executeTransaction(call);
      await provider.waitForTransaction(tx.transaction_hash);
      toast.success("✅ Lot created successfully");
      setNewProductor("");
      setNewRaza("");
      setNewPeso("");
      setNewCantidad("");
      setNewMetadata("");
      setNewDuration("3600");
      await fetchAllLots();
    } catch (e: any) {
      console.error("Error in createLot:", e);
      toast.error("❌ Failed to create lot: " + (e.message || JSON.stringify(e)));
    } finally {
      setIsLoading(false);
    }
  };

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
      const winnerAddr = activeAccountAddress; // Usamos la dirección activa

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

  const handleReveal = async () => {
    setErrorMessage("");
    if (!contract || !activeAccountAddress || !selectedLotId) return;
    if (!isAuctionActive(selectedLotInfo)) {
      toast.error("❌ Auction is not active");
      return;
    }
    setIsLoading(true);
    try {
      // Normalizar dirección actual
      const winnerAddrFormatted = toHexAddress(activeAccountAddress).toLowerCase();
      const key = `zk_${selectedLotId}_${winnerAddrFormatted}`;
      const storedData = localStorage.getItem(key);
      if (!storedData) {
        toast.error("No commit data found for this account");
        setIsLoading(false);
        return;
      }
      const bid = JSON.parse(storedData);
      const amountToUse = bid.amount;      // string
      const nonceToUse = bid.secret;       // string
      const storedWinner = bid.winner.toLowerCase();

      // Verificar que la dirección del commit coincida
      if (storedWinner !== winnerAddrFormatted) {
        console.error("Winner address mismatch", { storedWinner, winnerAddrFormatted });
        toast.error("Winner address mismatch");
        setIsLoading(false);
        return;
      }

      // Calcular commitment local para verificar consistencia
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

      console.log("Reveal usando datos de localStorage:", { amountToUse, nonceToUse, winnerAddrFormatted });
      console.log("Parámetros reveal:", { lot_id: selectedLotId, amount: amountToUse, nonce: nonceToUse });

      // Construcción manual del calldata para evitar problemas de serialización con Cavos
      const { low: amountLow, high: amountHigh } = splitU256(BigInt(amountToUse));
      const { low: lotLow, high: lotHigh } = splitU256(BigInt(selectedLotId));
      const calldata = [
        lotLow.toString(),
        lotHigh.toString(),
        amountLow.toString(),
        amountHigh.toString(),
        nonceToUse
      ];

      const call = {
        contractAddress: contract.address,
        entrypoint: 'reveal_bid',
        calldata,
      };

      console.log("Call manual:", call);

      const tx = await executeTransaction(call);
      await provider.waitForTransaction(tx.transaction_hash);

      // Actualizar información del lote
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
      toast.success("✅ Bid revealed");
    } catch (e: any) {
      console.error("Error in reveal:", e);
      toast.error("❌ Reveal failed: " + (e.message || JSON.stringify(e)));
    } finally {
      setIsLoading(false);
    }
  };

  const handleSimulatedPayment = () => {
    if (!activeAccountAddress || !selectedLotInfo) return;
    setPaidLotes((prev) => ({ ...prev, [selectedLotId]: true }));
    toast.success("✅ Private payment simulated with Tongo");
  };

  const handleZKProof = async () => {
    if (!activeAccountAddress || !selectedLotInfo || !selectedLotInfo.finalizado) return;
    if (normalizeAddress(selectedLotInfo.mejor_postor) !== normalizeAddress(activeAccountAddress)) {
      toast.error("Only the winner can generate the ZK proof");
      return;
    }

    if (calldataPago.length === 0) {
      toast.error("Payment calldata not available");
      return;
    }

    setIsLoading(true);
    try {
      const calldataAsStrings = calldataPago.map((item) => item.toString());
      let txHash: string;

      if (isCavosAuth) {
        txHash = await cavosExecute({
          contractAddress: VERIFIER_ADDRESS,
          entrypoint: "verify_ultra_keccak_honk_proof",
          calldata: calldataAsStrings,
        });
      } else if (walletAccount) {
        const tx = await walletAccount.execute({
          contractAddress: VERIFIER_ADDRESS,
          entrypoint: "verify_ultra_keccak_honk_proof",
          calldata: calldataAsStrings,
        });
        txHash = tx.transaction_hash;
      } else {
        throw new Error("No account connected");
      }

      await provider.waitForTransaction(txHash);
      toast.success("✅ Payment proof verified on‑chain");
      setProofGeneratedLotes((prev) => ({ ...prev, [selectedLotId]: true }));
      localStorage.setItem(`proof_tx_${selectedLotId}`, txHash);
    } catch (error: any) {
      console.error("❌ Verification error:", error);
      toast.error("Verification failed: " + error.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleFinalizeWithZK = async () => {
    if (!contract || !activeAccountAddress || !selectedLotId || !selectedLotInfo) return;
    if (!isOwner) {
      toast.error("Only the owner can finalize with ZK");
      return;
    }
    if (selectedLotInfo.finalizado) {
      toast.error("Lot already finalized");
      return;
    }

    if (calldataSeleccion.length === 0) {
      toast.error(`No pre‑generated calldata available for lot #${selectedLotId}. Please use a demo lot.`);
      return;
    }

    setIsLoading(true);
    try {
      // Verificar la prueba ZK en el verificador de selección
      const calldataAsStrings = calldataSeleccion.map((item) => item.toString());
      let txHash: string;

      if (isCavosAuth) {
        txHash = await cavosExecute({
          contractAddress: AUCTION_VERIFIER_ADDRESS,
          entrypoint: "verify_ultra_keccak_honk_proof",
          calldata: calldataAsStrings,
        });
      } else if (walletAccount) {
        const tx = await walletAccount.execute({
          contractAddress: AUCTION_VERIFIER_ADDRESS,
          entrypoint: "verify_ultra_keccak_honk_proof",
          calldata: calldataAsStrings,
        });
        txHash = tx.transaction_hash;
      } else {
        throw new Error("No account connected");
      }

      await provider.waitForTransaction(txHash);
      toast.success("✅ ZK proof verified on‑chain (selection)");

      // Finalizar el lote en el contrato de subasta
      const call = contract.populate("finalize_lot", [selectedLotId]);
      const tx2 = await executeTransaction(call);
      await provider.waitForTransaction(tx2.transaction_hash);

      // Obtener información actualizada del lote
      const updatedInfo = await contract.get_lot_info(selectedLotId);
      const updatedLot = {
        ...selectedLotInfo,
        ...updatedInfo,
        finalizado: updatedInfo.finalizado,
        mejor_puja: updatedInfo.mejor_puja?.toString() || "0",
        mejor_postor: toHexAddress(updatedInfo.mejor_postor),
      };
      setSelectedLotInfo(updatedLot);

      // Refresh all lots to get the updated status
      await fetchAllLots(true);

      // Marcar como finalizado con ZK
      setZkFinalizedLotes((prev) => ({ ...prev, [selectedLotId]: true }));

      // Store transaction hashes
      localStorage.setItem(`proof_tx_${selectedLotId}`, txHash);
      localStorage.setItem(`finalize_tx_${selectedLotId}`, tx2.transaction_hash);

      toast.success("✅ Lot finalized with ZK (fixed calldata)");
    } catch (error: any) {
      console.error("❌ Finalization error:", error);
      toast.error("Verification failed: " + error.message);
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
  const hasPaid = paidLotes[selectedLotId];
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
              placeholder="Metadata URI (ipfs://...)"
              value={newMetadata}
              onChange={(e) => setNewMetadata(e.target.value)}
            />
            <input
              type="number"
              className="input input-bordered"
              placeholder="Duration (seconds, e.g. 3600 for 1h)"
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
              !newMetadata ||
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
                  const pagado = esGanador && paidLotes[lot.id.toString()];
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
                        {pagado ? (
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

          {isOwner && !selectedLotInfo.finalizado && (
            <button
              className="btn btn-success w-full mb-4"
              onClick={handleFinalizeWithZK}
              disabled={isLoading}
            >
              {isLoading ? "Finalizing with ZK..." : "🔐 Finalize with ZK (fixed calldata)"}
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

          {/* Simulated payment button – only if winner has NOT generated ZK proof yet */}
          {selectedLotInfo.finalizado &&
            normalizeAddress(selectedLotInfo.mejor_postor) === normalizeAddress(activeAccountAddress) &&
            !hasPaid && !hasGeneratedProof && (
              <button
                className="btn btn-accent w-full mt-4"
                onClick={handleSimulatedPayment}
                disabled={isLoading}
              >
                {isLoading ? "Processing..." : "💰 Pay with Privacy (Simulated)"}
              </button>
            )}

          {/* Paid message (simulated) */}
          {selectedLotInfo.finalizado &&
            normalizeAddress(selectedLotInfo.mejor_postor) === normalizeAddress(activeAccountAddress) &&
            hasPaid && (
              <div className="alert alert-success mt-4">
                ✅ You have paid for this lot. Thank you for your participation.
              </div>
            )}

          {/* ZK proof button – only for winner if not generated */}
          {selectedLotInfo.finalizado &&
            normalizeAddress(selectedLotInfo.mejor_postor) === normalizeAddress(activeAccountAddress) &&
            !hasGeneratedProof && (
              <button
                className="btn btn-primary w-full mt-4"
                onClick={handleZKProof}
                disabled={isLoading}
              >
                {isLoading ? "Generating..." : "🔐 Verify Payment with ZK (fixed calldata)"}
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