use starknet::ContractAddress;
use core::num::traits::Zero;
use core::poseidon::poseidon_hash_span;
use starknet::get_block_timestamp;
use starknet::get_tx_info;
use core::byte_array::ByteArray;

#[derive(Drop, Serde, starknet::Store)]
pub struct LotInfo {
    pub productor: ContractAddress,
    pub raza: felt252,
    pub peso_inicial: u256,
    pub cantidad_animales: u256,
    pub metadata_uri: ByteArray,
    pub start_time: u64,
    pub duration: u64,
    pub finalizado: bool,
    pub mejor_puja: u256,
    pub mejor_postor: ContractAddress,
}

#[starknet::interface]
pub trait ISealedBidFeedlot<TContractState> {
    fn create_lot(
        ref self: TContractState,
        lot_id: u256,
        productor: ContractAddress,
        raza: felt252,
        peso_inicial: u256,
        cantidad_animales: u256,
        metadata_uri: ByteArray,
        duration: u64
    );
    fn commit_bid(ref self: TContractState, lot_id: u256, commitment: felt252);
    fn reveal_bid(ref self: TContractState, lot_id: u256, amount: u256, nonce: felt252);
    fn finalize_lot(ref self: TContractState, lot_id: u256);
    fn get_winning_bid(self: @TContractState, lot_id: u256) -> u256;
    fn get_lot_info(self: @TContractState, lot_id: u256) -> LotInfo;
    fn get_lot_count(self: @TContractState) -> u256;
    // ZK related functions
    fn set_auction_verifier(ref self: TContractState, verifier_address: ContractAddress);
    fn finalize_with_zk(ref self: TContractState, lot_id: u256, winner: ContractAddress, winner_amount: u256, proof: Span<felt252>);
    // Bidders management
    fn get_bidders_count(self: @TContractState, lot_id: u256) -> u32;
    fn get_bidder_at(self: @TContractState, lot_id: u256, index: u32) -> ContractAddress;
    // Payment verification
    fn set_payment_verifier(ref self: TContractState, verifier_address: ContractAddress);
    fn verify_payment(ref self: TContractState, lot_id: u256, proof: Span<felt252>);
    fn is_payment_done(self: @TContractState, lot_id: u256) -> bool;
    // Winner registry
    fn get_winner(self: @TContractState, lot_id: u256) -> (ContractAddress, u256);
    // Debug function
    fn debug_reveal(self: @TContractState, lot_id: u256, amount: u256, nonce: felt252) -> (felt252, felt252, ContractAddress, ContractAddress);
    // New function to retrieve all revealed bids for a lot
    fn get_revealed_bids(self: @TContractState, lot_id: u256) -> Array<(ContractAddress, u256, felt252)>;
}

// Interface for the auction verifier (used in finalize_with_zk)
#[starknet::interface]
pub trait IAuctionVerifier<TContractState> {
    fn verify_ultra_keccak_honk_proof(self: @TContractState, full_proof_with_hints: Span<felt252>) -> Option<Span<u256>>;
}

// Note: IPaymentVerifier is not directly used because we call via syscall, so we can omit it.
// If you want to keep it for consistency, add #[allow(unused_imports)] when importing.

#[starknet::contract]
mod SealedBidFeedlot {
    use super::{
        ISealedBidFeedlot, poseidon_hash_span, LotInfo, Zero, get_block_timestamp, ByteArray, get_tx_info
    };
    use starknet::{ContractAddress, get_caller_address};
    use starknet::storage::{Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess, StoragePointerWriteAccess};

    #[storage]
    struct Storage {
        commitments: Map<(ContractAddress, u256), felt252>,
        lots: Map<u256, LotInfo>,
        owner: Map<(), ContractAddress>,
        lot_count: felt252,
        bidders_count: Map<u256, u32>,
        bidder_at: Map<(u256, u32), ContractAddress>,
        auction_verifier: ContractAddress,
        payment_verifier: ContractAddress,
        payment_done: Map<u256, bool>,
        // Winner registry (address and amount)
        winner_record: Map<u256, (ContractAddress, u256)>,
        // Storage for all revealed bids per lot
        revealed_bids: Map<(u256, u32), (ContractAddress, u256, felt252)>,
        revealed_bids_count: Map<u256, u32>,
    }

    #[constructor]
    fn constructor(ref self: ContractState, owner: ContractAddress) {
        self.owner.write((), owner);
        self.auction_verifier.write(Zero::zero());
        self.payment_verifier.write(Zero::zero());
    }

    #[abi(embed_v0)]
    impl SealedBidFeedlotImpl of ISealedBidFeedlot<ContractState> {
        fn create_lot(
            ref self: ContractState,
            lot_id: u256,
            productor: ContractAddress,
            raza: felt252,
            peso_inicial: u256,
            cantidad_animales: u256,
            metadata_uri: ByteArray,
            duration: u64
        ) {
            assert(get_caller_address() == self.owner.read(()), 'Not owner');
            let existing = self.lots.read(lot_id);
            assert(existing.productor.is_zero(), 'Lot already exists');

            let lot = LotInfo {
                productor,
                raza,
                peso_inicial,
                cantidad_animales,
                metadata_uri,
                start_time: get_block_timestamp(),
                duration,
                finalizado: false,
                mejor_puja: 0_u256,
                mejor_postor: Zero::zero(),
            };
            self.lots.write(lot_id, lot);
            
            let current_count = self.lot_count.read();
            self.lot_count.write(current_count + 1);
        }

        fn commit_bid(ref self: ContractState, lot_id: u256, commitment: felt252) {
            let lot = self.lots.read(lot_id);
            assert(!lot.productor.is_zero(), 'Lot does not exist');
            assert(!lot.finalizado, 'Lot already finalized');
            assert(get_block_timestamp() < lot.start_time + lot.duration, 'Auction ended');

            let tx_info = get_tx_info().unbox();
            let caller = tx_info.account_contract_address;
            self.commitments.write((caller, lot_id), commitment);
            
            let count = self.bidders_count.read(lot_id);
            let mut already_exists = false;
            let mut i = 0;
            while i < count {
                if self.bidder_at.read((lot_id, i)) == caller {
                    already_exists = true;
                    break;
                };
                i += 1;
            };
            
            if !already_exists {
                self.bidder_at.write((lot_id, count), caller);
                self.bidders_count.write(lot_id, count + 1);
            }
        }

        fn reveal_bid(ref self: ContractState, lot_id: u256, amount: u256, nonce: felt252) {
            let lot = self.lots.read(lot_id);
            assert(!lot.productor.is_zero(), 'Lot does not exist');
            assert(!lot.finalizado, 'Lot already finalized');
            assert(get_block_timestamp() < lot.start_time + lot.duration, 'Auction ended');

            let tx_info = get_tx_info().unbox();
            let caller = tx_info.account_contract_address;
            let computed_commitment = poseidon_hash_span(
                array![nonce, amount.low.into(), lot_id.low.into(), caller.into()].span()
            );
            let stored_commitment = self.commitments.read((caller, lot_id));
            assert(computed_commitment == stored_commitment, 'Commitment mismatch');

            if amount > lot.mejor_puja {
                let mut updated_lot = lot;
                updated_lot.mejor_puja = amount;
                updated_lot.mejor_postor = caller;
                self.lots.write(lot_id, updated_lot);
            }

            // Store the revealed bid for future reference (e.g., for ZK proof generation)
            let count = self.revealed_bids_count.read(lot_id);
            self.revealed_bids.write((lot_id, count), (caller, amount, nonce));
            self.revealed_bids_count.write(lot_id, count + 1);
        }

        fn finalize_lot(ref self: ContractState, lot_id: u256) {
            assert(get_caller_address() == self.owner.read(()), 'Not owner');
            let mut lot = self.lots.read(lot_id);
            assert(!lot.finalizado, 'Already finalized');
            
            // Capture winner info before moving lot
            let winner = lot.mejor_postor;
            let amount = lot.mejor_puja;
            
            lot.finalizado = true;
            self.lots.write(lot_id, lot); // lot is moved here
            
            // Register winner if exists
            if !winner.is_zero() {
                self.winner_record.write(lot_id, (winner, amount));
                self.emit(WinnerRecorded { lot_id, winner, amount });
            }
        }

        fn get_winning_bid(self: @ContractState, lot_id: u256) -> u256 {
            self.lots.read(lot_id).mejor_puja
        }

        fn get_lot_info(self: @ContractState, lot_id: u256) -> LotInfo {
            self.lots.read(lot_id)
        }

        fn get_lot_count(self: @ContractState) -> u256 {
            self.lot_count.read().into()
        }

        fn get_bidders_count(self: @ContractState, lot_id: u256) -> u32 {
            self.bidders_count.read(lot_id)
        }

        fn get_bidder_at(self: @ContractState, lot_id: u256, index: u32) -> ContractAddress {
            self.bidder_at.read((lot_id, index))
        }

        fn set_auction_verifier(ref self: ContractState, verifier_address: ContractAddress) {
            assert(get_caller_address() == self.owner.read(()), 'Not owner');
            self.auction_verifier.write(verifier_address);
        }

        fn finalize_with_zk(
            ref self: ContractState,
            lot_id: u256,
            winner: ContractAddress,
            winner_amount: u256,
            proof: Span<felt252>
        ) {
            assert(get_caller_address() == self.owner.read(()), 'Not owner');
            
            let lot = self.lots.read(lot_id);
            assert(!lot.productor.is_zero(), 'Lot does not exist');
            assert(!lot.finalizado, 'Already finalized');
            
            let verifier_address = self.auction_verifier.read();
            assert(!verifier_address.is_zero(), 'Verifier not set');
            
            let selector = selector!("verify_ultra_keccak_honk_proof");
            let result = starknet::syscalls::call_contract_syscall(
                verifier_address,
                selector,
                proof
            );
            
            match result {
                Result::Ok(_) => {},
                Result::Err(_) => assert(false, 'Proof verification failed'),
            };
            
            let mut updated_lot = lot;
            updated_lot.finalizado = true;
            updated_lot.mejor_postor = winner;
            updated_lot.mejor_puja = winner_amount;
            self.lots.write(lot_id, updated_lot);
            
            // Register winner (winner and winner_amount are parameters, not moved)
            self.winner_record.write(lot_id, (winner, winner_amount));
            self.emit(AuctionFinalized { lot_id, winner, winner_amount });
        }

        fn set_payment_verifier(ref self: ContractState, verifier_address: ContractAddress) {
            assert(get_caller_address() == self.owner.read(()), 'Not owner');
            self.payment_verifier.write(verifier_address);
        }

        fn verify_payment(ref self: ContractState, lot_id: u256, proof: Span<felt252>) {
            let lot = self.lots.read(lot_id);
            assert(!lot.productor.is_zero(), 'Lot does not exist');
            assert(lot.finalizado, 'Lot not finalized');
            
            let winner = lot.mejor_postor;
            assert(get_caller_address() == winner, 'Only winner can pay');
            assert(!self.payment_done.read(lot_id), 'Payment already done');
            
            let verifier = self.payment_verifier.read();
            assert(!verifier.is_zero(), 'Payment verifier not set');
            
            let selector = selector!("verify_ultra_keccak_honk_proof");
            let result = starknet::syscalls::call_contract_syscall(
                verifier,
                selector,
                proof
            );
            
            match result {
                Result::Ok(_) => {},
                Result::Err(_) => assert(false, 'Payment proof failed'),
            };
            
            self.payment_done.write(lot_id, true);
            self.emit(PaymentVerified { lot_id, winner });
        }

        fn is_payment_done(self: @ContractState, lot_id: u256) -> bool {
            self.payment_done.read(lot_id)
        }

        fn get_winner(self: @ContractState, lot_id: u256) -> (ContractAddress, u256) {
            self.winner_record.read(lot_id)
        }

        fn debug_reveal(self: @ContractState, lot_id: u256, amount: u256, nonce: felt252) -> (felt252, felt252, ContractAddress, ContractAddress) {
            let tx_info = get_tx_info().unbox();
            let account_address = tx_info.account_contract_address;
            let caller = get_caller_address();
            
            let computed = poseidon_hash_span(
                array![
                    nonce,
                    amount.low.into(),
                    lot_id.low.into(),
                    account_address.into()
                ].span()
            );
            let stored = self.commitments.read((account_address, lot_id));
            
            (computed, stored, account_address, caller)
        }

        // New function to retrieve all revealed bids for a given lot
        fn get_revealed_bids(self: @ContractState, lot_id: u256) -> Array<(ContractAddress, u256, felt252)> {
            let mut bids = ArrayTrait::new();
            let count = self.revealed_bids_count.read(lot_id);
            let mut i = 0;
            while i < count {
                let bid = self.revealed_bids.read((lot_id, i));
                bids.append(bid);
                i += 1;
            };
            bids
        }
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        AuctionFinalized: AuctionFinalized,
        PaymentVerified: PaymentVerified,
        WinnerRecorded: WinnerRecorded,
    }

    #[derive(Drop, starknet::Event)]
    struct AuctionFinalized {
        #[key]
        lot_id: u256,
        winner: ContractAddress,
        winner_amount: u256,
    }

    #[derive(Drop, starknet::Event)]
    struct PaymentVerified {
        #[key]
        lot_id: u256,
        winner: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    struct WinnerRecorded {
        #[key]
        lot_id: u256,
        winner: ContractAddress,
        amount: u256,
    }
}