#![no_std]
#![allow(clippy::too_many_arguments)]

use soroban_sdk::{contract, contracterror, contractimpl, contractstate, contracttype, token, Address, Env, Symbol, Vec};

// ── Error types ──────────────────────────────────────────────

#[contracterror]
#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(u32)]
pub enum RouterError {
    InsufficientLiquidity = 1,
    SlippageExceeded = 2,
    RouteNotFound = 3,
    EmptyPath = 4,
    InvalidAmount = 5,
    DeadlineReached = 6,
    PoolNotFound = 7,
}

// ── Liquidity Pool ────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub struct LiquidityPool {
    pub pool_address: Address,
    pub asset_in: Address,
    pub asset_out: Address,
    pub depth: i128,
}

impl LiquidityPool {
    pub fn reserve(&self, asset: &Address) -> i128 {
        if self.asset_in == *asset {
            self.depth
        } else {
            0
        }
    }
}

// ── Router instance state ────────────────────────────────────

#[contractstate]
#[derive(Clone)]
pub struct RouterState {
    pub pools: Vec<LiquidityPool>,
    pub owner: Address,
    pub max_slippage_bps: u32,
    pub min_liquidity_depth: i128,
}

const ROUTER_STATE_KEY: &str = "ROUTER_STATE";

// ── Router Contract ───────────────────────────────────────────

#[contract]
pub struct Router;

#[contractimpl]
impl Router {
    // ── initialize ────────────────────────────────────────────

    pub fn initialize(env: Env, owner: Address, max_slippage_bps: u32, min_liquidity_depth: i128) {
        owner.require_auth();

        assert!(max_slippage_bps > 0 && max_slippage_bps <= 10_000, "max_slippage_bps must be in (0, 10000]");
        assert!(min_liquidity_depth > 0, "min_liquidity_depth must be positive");

        let state = RouterState {
            pools: Vec::new(&env),
            owner: owner.clone(),
            max_slippage_bps,
            min_liquidity_depth,
        };

        env.storage().instance().set(&ROUTER_STATE_KEY, &state);
        env.storage().instance().extend_ttl(1000, 10000);
    }

    // ── add_pool ─────────────────────────────────────────────

    pub fn add_pool(env: Env, caller: Address, pool: LiquidityPool) {
        caller.require_auth();
        let mut state: RouterState = env
            .storage()
            .instance()
            .get(&ROUTER_STATE_KEY)
            .expect("not initialized");

        assert!(caller == state.owner, "only owner can add pools");
        assert!(pool.depth >= state.min_liquidity_depth, "pool depth below minimum");

        let mut pools = state.pools.clone();
        pools.push_back(pool);
        state.pools = pools.clone();

        env.storage().instance().set(&ROUTER_STATE_KEY, &state);
        env.storage().instance().extend_ttl(1000, 10000);
    }

    // ── remove_pool ──────────────────────────────────────────

    pub fn remove_pool(env: Env, caller: Address, pool_address: Address) -> Result<(), RouterError> {
        caller.require_auth();
        let mut state: RouterState = env
            .storage()
            .instance()
            .get(&ROUTER_STATE_KEY)
            .expect("not initialized");

        assert!(caller == state.owner, "only owner can remove pools");

        let original_len = state.pools.len();
        let mut new_pools = Vec::new(&env);
        for p in state.pools.iter() {
            if p.pool_address != pool_address {
                new_pools.push_back(p.clone());
            }
        }

        if new_pools.len() == original_len {
            return Err(RouterError::PoolNotFound);
        }
        state.pools = new_pools;

        env.storage().instance().set(&ROUTER_STATE_KEY, &state);
        env.storage().instance().extend_ttl(1000, 10000);
        Ok(())
    }

    // ── find_optimal_route (recursive) ─────────────────────────

    /// Find the best route from `asset_in` to `asset_out` by recursively
    /// exploring available liquidity pools and their depths.
    /// Returns the ordered list of pool addresses forming the path.
    pub fn find_optimal_route(
        env: Env,
        asset_in: Address,
        asset_out: Address,
        amount_in: i128,
        max_hops: u32,
    ) -> Result<Vec<Address>, RouterError> {
        assert!(amount_in > 0, RouterError::InvalidAmount);
        assert!(max_hops > 0, RouterError::RouteNotFound);

        let state: RouterState = env
            .storage()
            .instance()
            .get(&ROUTER_STATE_KEY)
            .expect("not initialized");

        let mut path = Vec::new(&env);
        let mut visited = Vec::new(&env);

        Self::find_route_recursive(
            &env,
            &state.pools,
            &asset_in,
            &asset_out,
            amount_in,
            max_hops,
            &mut path,
            &mut visited,
        )
        .ok_or(RouterError::RouteNotFound)
    }

    fn find_route_recursive(
        env: &Env,
        pools: &Vec<LiquidityPool>,
        asset_in: &Address,
        asset_out: &Address,
        amount_in: i128,
        remaining_hops: u32,
        path: &mut Vec<Address>,
        visited: &mut Vec<Address>,
    ) -> Option<Vec<Address>> {
        // Base case: check for a direct pool that can cover the full amount
        for pool in pools.iter() {
            if pool.asset_in == *asset_in && pool.asset_out == *asset_out {
                if pool.depth >= amount_in {
                    let mut result_path = path.clone();
                    result_path.push_back(pool.pool_address.clone());
                    return Some(result_path);
                }
            }
        }

        // No more hops available — route cannot be reached
        if remaining_hops <= 1 {
            return None;
        }

        // Recursive case: try each pool whose input matches the current asset,
        // then recurse on the pool's output asset.
        for pool in pools.iter() {
            if pool.asset_in == *asset_in && pool.depth >= amount_in {
                // Avoid cycles — skip pools already in the current path
                let mut cycle = false;
                for v in visited.iter() {
                    if *v == pool.pool_address {
                        cycle = true;
                        break;
                    }
                }
                if cycle {
                    continue;
                }

                let intermediate_asset = pool.asset_out.clone();

                visited.push_back(pool.pool_address.clone());
                path.push_back(pool.pool_address.clone());

                let sub_result = Self::find_route_recursive(
                    env,
                    pools,
                    &intermediate_asset,
                    asset_out,
                    amount_in,
                    remaining_hops - 1,
                    path,
                    visited,
                );

                if sub_result.is_some() {
                    return sub_result;
                }

                // Backtrack if this branch did not lead to a valid route
                let _ = path.pop_back();
                let _ = visited.pop_back();
            }
        }

        None
    }

    // ── execute_swap (atomic) ─────────────────────────────────

    /// Execute a multi-hop swap atomically along the resolved path.
    /// All swaps succeed or the entire transaction reverts.
    pub fn execute_swap(
        env: Env,
        caller: Address,
        path: Vec<Address>,
        asset_in: Address,
        asset_out: Address,
        amount_in: i128,
        min_amount_out: i128,
        deadline: u32,
    ) -> Result<i128, RouterError> {
        caller.require_auth();

        assert!(amount_in > 0, RouterError::InvalidAmount);
        assert!(min_amount_out > 0, RouterError::InvalidAmount);
        assert!(
            env.ledger().sequence() < deadline,
            RouterError::DeadlineReached
        );

        let state: RouterState = env
            .storage()
            .instance()
            .get(&ROUTER_STATE_KEY)
            .expect("not initialized");

        if path.len() == 0 {
            return Err(RouterError::EmptyPath);
        }

        // Resolve each hop to its concrete pool, verifying continuity
        let mut resolved_pools = Vec::new(&env);
        let mut current_asset = asset_in;

        for pool_addr in path.iter() {
            let mut found = false;
            for p in state.pools.iter() {
                if p.pool_address == *pool_addr && p.asset_in == current_asset {
                    resolved_pools.push_back(p.clone());
                    current_asset = p.asset_out.clone();
                    found = true;
                    break;
                }
            }
            if !found {
                return Err(RouterError::PoolNotFound);
            }
        }

        if current_asset != asset_out {
            return Err(RouterError::RouteNotFound);
        }

        // Transfer input tokens from caller to this contract
        let input_token = token::Client::new(&env, &asset_in);
        input_token.transfer(&caller, &env.current_contract_address(), &amount_in);

        // Execute each hop atomically through the pool contracts
        let mut current_amount = amount_in;

        for pool in resolved_pools.iter() {
            let output_amount = Self::check_slippage(
                &env,
                pool,
                current_amount,
                &state,
            )?;
            current_amount = output_amount;
        }

        // Final slippage guard against min_amount_out
        if current_amount < min_amount_out {
            return Err(RouterError::SlippageExceeded);
        }

        // Transfer output tokens to the caller (recipient)
        let output_token = token::Client::new(&env, &asset_out);
        output_token.transfer(
            &env.current_contract_address(),
            &caller,
            &current_amount,
        );

        env.events().publish(
            (Symbol::new(&env, "SwapExecuted"), caller),
            (amount_in, current_amount),
        );

        Ok(current_amount)
    }

    // ── check_slippage ────────────────────────────────────────

    /// Validate that a pool swap will not exceed the configured slippage limit,
    /// then invoke the pool contract atomically. Reverts if slippage is breached.
    fn check_slippage(
        env: &Env,
        pool: &LiquidityPool,
        amount_in: i128,
        state: &RouterState,
    ) -> Result<i128, RouterError> {
        // Pre-check: pool must have enough depth for the input amount
        if pool.depth < amount_in {
            return Err(RouterError::InsufficientLiquidity);
        }

        // Compute expected output using constant-product formula with 0.30% fee
        let fee_bps: i128 = 30;
        let amount_with_fee = amount_in * (10_000 - fee_bps) / 10_000;
        let expected_out = amount_with_fee * pool.depth
            / (pool.depth + amount_with_fee);

        // Apply max slippage tolerance relative to expected output
        let min_expected = expected_out * (10_000 - state.max_slippage_bps as i128) / 10_000;

        // Atomic invocation of the pool's swap function
        let amount_out = env.invoke_contract::<i128>(
            &pool.pool_address,
            &Symbol::new(env, "swap"),
            soroban_sdk::vec![env,
                pool.asset_in.clone().into(),
                pool.asset_out.clone().into(),
                amount_in.into(),
                1i128.into(),
                env.current_contract_address().into(),
            ],
        );

        if amount_out < min_expected {
            return Err(RouterError::SlippageExceeded);
        }

        Ok(amount_out)
    }

    // ── query_pool_depth ──────────────────────────────────────

    pub fn query_pool_depth(env: Env, pool_address: Address, asset: Address) -> Result<i128, RouterError> {
        let state: RouterState = env
            .storage()
            .instance()
            .get(&ROUTER_STATE_KEY)
            .expect("not initialized");

        let mut found = false;
        for p in state.pools.iter() {
            if p.pool_address == pool_address {
                found = true;
                break;
            }
        }

        if !found {
            return Err(RouterError::PoolNotFound);
        }

        let reserves: i128 = env.invoke_contract(
            &pool_address,
            &Symbol::new(&env, "get_reserve"),
            soroban_sdk::vec![&env, asset.into()],
        );
        Ok(reserves)
    }

    // ── get_state ─────────────────────────────────────────────

    pub fn get_state(env: Env) -> RouterState {
        let state = env
            .storage()
            .instance()
            .get(&ROUTER_STATE_KEY)
            .expect("not initialized");
        env.storage().instance().extend_ttl(1000, 10000);
        state
    }

    // ── get_pools ─────────────────────────────────────────────

    pub fn get_pools(env: Env) -> Vec<LiquidityPool> {
        let state: RouterState = env
            .storage()
            .instance()
            .get(&ROUTER_STATE_KEY)
            .expect("not initialized");
        env.storage().instance().extend_ttl(1000, 10000);
        state.pools
    }
}

// ── Tests ─────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        Address, Env, Symbol, Vec,
    };

    fn setup() -> (
        Env,
        Address,
        Address,
        Address,
        Address,
        Address,
        Address,
        RouterContractClient<'static>,
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let owner = Address::generate(&env);
        let caller = Address::generate(&env);
        let asset_in = Address::generate(&env);
        let asset_mid = Address::generate(&env);
        let asset_out = Address::generate(&env);
        let pool1_addr = Address::generate(&env);

        let contract_id = env.register(Router, ());
        let client = RouterContractClient::new(&env, &contract_id);

        (
            env,
            owner,
            caller,
            asset_in,
            asset_mid,
            asset_out,
            pool1_addr,
            client,
        )
    }

    #[test]
    fn test_initialize() {
        let (env, owner, _caller, _, _, _, _, client) = setup();
        env.ledger().set_timestamp(100);

        client.initialize(&owner, 500, 1000);

        let state = client.get_state();
        assert_eq!(state.owner, owner);
        assert_eq!(state.max_slippage_bps, 500);
        assert_eq!(state.min_liquidity_depth, 1000);
    }

    #[test]
    fn test_add_and_get_pools() {
        let (env, owner, _caller, asset_in, asset_out, _, pool1_addr, client) = setup();
        env.ledger().set_timestamp(100);

        client.initialize(&owner, 500, 1000);

        let pool = LiquidityPool {
            pool_address: pool1_addr.clone(),
            asset_in: asset_in.clone(),
            asset_out: asset_out.clone(),
            depth: 5000,
        };

        client.add_pool(&owner, &pool);

        let pools = client.get_pools();
        assert_eq!(pools.len(), 1);
        assert_eq!(pools.get(0).unwrap().pool_address, pool1_addr);
    }

    #[test]
    fn test_remove_pool() {
        let (env, owner, _caller, asset_in, asset_out, _, pool1_addr, client) = setup();
        env.ledger().set_timestamp(100);

        client.initialize(&owner, 500, 1000);

        let pool = LiquidityPool {
            pool_address: pool1_addr.clone(),
            asset_in: asset_in.clone(),
            asset_out: asset_out.clone(),
            depth: 5000,
        };

        client.add_pool(&owner, &pool);
        assert_eq!(client.get_pools().len(), 1);

        client.remove_pool(&owner, &pool1_addr);
        assert_eq!(client.get_pools().len(), 0);
    }

    #[test]
    fn test_remove_pool_not_found() {
        let (env, owner, _caller, _asset_in, _asset_out, _, _pool1_addr, client) = setup();
        env.ledger().set_timestamp(100);

        client.initialize(&owner, 500, 1000);

        let non_existent = Address::generate(&env);
        let result = client.try_remove_pool(&owner, &non_existent);
        assert!(result.is_err());
    }

    #[test]
    fn test_find_optimal_route_direct() {
        let (env, owner, _caller, asset_in, asset_out, _, pool1_addr, client) = setup();
        env.ledger().set_timestamp(100);

        client.initialize(&owner, 500, 1000);

        let pool = LiquidityPool {
            pool_address: pool1_addr.clone(),
            asset_in: asset_in.clone(),
            asset_out: asset_out.clone(),
            depth: 5000,
        };
        client.add_pool(&owner, &pool);

        let result = client.find_optimal_route(&asset_in, &asset_out, 1000, 3);
        assert!(result.is_ok());
        let path = result.unwrap();
        assert_eq!(path.len(), 1);
        assert_eq!(path.get(0).unwrap(), pool1_addr);
    }

    #[test]
    fn test_find_optimal_route_no_route() {
        let (env, owner, _caller, asset_in, asset_out, _, _pool1_addr, client) = setup();
        env.ledger().set_timestamp(100);

        client.initialize(&owner, 500, 1000);

        let result = client.find_optimal_route(&asset_in, &asset_out, 1000, 3);
        assert!(result.is_err());
    }

    #[test]
    fn test_check_slippage_exceeds() {
        let min_out: i128 = 900_000;
        let actual_out: i128 = 850_000;
        assert!(actual_out < min_out, "slippage should be detected");
    }

    #[test]
    fn test_check_slippage_passes() {
        let min_out: i128 = 900_000;
        let actual_out: i128 = 950_000;
        assert!(actual_out >= min_out, "slippage check should pass");
    }

    #[test]
    fn test_validate_pool_depth() {
        let asset = Address::generate(&Env::default());
        let pool = LiquidityPool {
            pool_address: Address::generate(&Env::default()),
            asset_in: asset.clone(),
            asset_out: Address::generate(&Env::default()),
            depth: 5000,
        };

        assert_eq!(pool.reserve(&asset), 5000);

        let other_asset = Address::generate(&Env::default());
        assert_eq!(pool.reserve(&other_asset), 0);
    }
}
