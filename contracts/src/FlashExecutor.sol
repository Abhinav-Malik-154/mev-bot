// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title FlashExecutor
 * @author MEV Searcher Bot
 * @notice Atomic arbitrage executor for Uniswap V2 pool pairs.
 * @dev Executes two-hop arbitrage: buy cheap on poolA, sell expensive on poolB.
 *      All execution is atomic — partial fills are impossible.
 *      Only the owner (searcher bot wallet) can trigger execution.
 *
 * Security model:
 * - onlyOwner: prevents unauthorized arbitrage calls
 * - nonReentrant: prevents reentrancy attacks via malicious tokens
 * - amountOutMin params: prevents sandwich attacks on our own tx
 * - deadline: prevents tx from being held and replayed in bad conditions
 */

// ─── Interfaces ───────────────────────────────────────────────────────────────

/// @notice Minimal Uniswap V2 pair interface required for arbitrage execution
interface IUniswapV2Pair {
    /// @notice Returns the current reserves and last update timestamp
    /// @return reserve0 Reserve of token0
    /// @return reserve1 Reserve of token1
    /// @return blockTimestampLast Last block timestamp when reserves were updated
    function getReserves()
        external
        view
        returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);

    /// @notice Executes a swap, sending output directly to `to`
    /// @param amount0Out Amount of token0 to send out (0 if receiving token1)
    /// @param amount1Out Amount of token1 to send out (0 if receiving token0)
    /// @param to Recipient of the output tokens
    /// @param data Callback data (empty bytes for standard swaps)
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;

    /// @notice Returns the address of the lower-sorted token in this pair
    function token0() external view returns (address);

    /// @notice Returns the address of the higher-sorted token in this pair
    function token1() external view returns (address);
}

/// @notice Minimal ERC20 interface used by FlashExecutor
interface IERC20 {
    /// @notice Transfers `amount` tokens to `to`
    /// @param to Recipient address
    /// @param amount Token amount
    /// @return success True on success
    function transfer(address to, uint256 amount) external returns (bool);

    /// @notice Transfers `amount` from `from` to `to` using the caller's allowance
    /// @param from Source address
    /// @param to Destination address
    /// @param amount Token amount
    /// @return success True on success
    function transferFrom(address from, address to, uint256 amount) external returns (bool);

    /// @notice Grants `spender` an allowance of `amount`
    /// @param spender Address to approve
    /// @param amount Allowance amount
    /// @return success True on success
    function approve(address spender, uint256 amount) external returns (bool);

    /// @notice Returns the token balance held by `account`
    /// @param account Address to query
    /// @return balance Current balance
    function balanceOf(address account) external view returns (uint256);
}

// ─── Contract ─────────────────────────────────────────────────────────────────

contract FlashExecutor {
    // ── State ────────────────────────────────────────────────────────────────

    /// @notice Immutable deployer address; the only EOA permitted to call executeArbitrage
    address public immutable owner;

    /// @dev Single-slot reentrancy lock (true = call in progress)
    bool private locked;

    /// @notice Tracks approved router addresses for future extensibility
    mapping(address => bool) public approvedRouters;

    // ── Events ───────────────────────────────────────────────────────────────

    /**
     * @notice Emitted after every successful two-leg arbitrage round-trip
     * @param tokenIn   The token used as capital and returned as profit
     * @param tokenOut  The intermediate token swapped through
     * @param amountIn  Capital deployed by the owner
     * @param profit    Total tokenIn received back (capital + net gain)
     * @param blockNumber Block number of execution
     */
    event ArbitrageExecuted(
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 profit,
        uint256 blockNumber
    );

    /**
     * @notice Emitted when the owner rescues stuck ERC20 tokens
     * @param token     Address of the rescued ERC20
     * @param amount    Amount transferred out
     * @param recipient Destination for the rescued tokens
     */
    event EmergencyWithdraw(address indexed token, uint256 amount, address indexed recipient);

    /**
     * @notice Emitted when an approved-router entry is toggled
     * @param router   Affected router address
     * @param approved New approval state
     */
    event RouterApproved(address indexed router, bool approved);

    // ── Custom Errors ────────────────────────────────────────────────────────

    /// @dev msg.sender is not the owner
    error NotOwner();

    /// @dev A reentrant call was detected
    error ReentrantCall();

    /// @dev block.timestamp exceeds the provided deadline
    error DeadlineExpired();

    /**
     * @dev The arb returned zero tokenIn (catastrophic loss)
     * @param expected Minimum profit that was required
     * @param actual   Profit that was actually achieved
     */
    error InsufficientProfit(uint256 expected, uint256 actual);

    /**
     * @dev A pool swap returned fewer tokens than the slippage minimum
     * @param pool Address of the pool that failed the minimum-out check
     */
    error SwapFailed(address pool);

    /// @dev tokenIn or tokenOut is address(0)
    error InvalidPath();

    /// @dev amountIn was zero
    error ZeroAmount();

    // ── Modifiers ────────────────────────────────────────────────────────────

    /// @dev Reverts with NotOwner() if caller is not the owner
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @dev Locks execution to prevent reentrancy
    modifier nonReentrant() {
        if (locked) revert ReentrantCall();
        locked = true;
        _;
        locked = false;
    }

    /**
     * @dev Reverts with DeadlineExpired() if the deadline has passed
     * @param deadline Unix timestamp after which the call is invalid
     */
    modifier validDeadline(uint256 deadline) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        _;
    }

    // ── Constructor ──────────────────────────────────────────────────────────

    /// @notice Sets the deployer as the permanent owner
    constructor() {
        owner = msg.sender;
    }

    // ── External Functions ───────────────────────────────────────────────────

    /**
     * @notice Executes a two-pool arbitrage cycle atomically
     * @dev Execution flow:
     *      1. Record pre-arb tokenIn balance (balanceBefore)
     *      2. Pull amountIn from owner via transferFrom
     *      3. Leg A — transfer tokenIn to poolA, swap → receive tokenOut
     *      4. Leg B — transfer tokenOut to poolB, swap → receive tokenIn
     *      5. profit = balanceAfter - balanceBefore
     *      6. Revert if profit == 0; otherwise transfer profit to owner
     *
     *      Stack depth is managed by delegating each swap leg to _executeSwap().
     *
     * @param tokenIn       Token used as capital (e.g., WETH)
     * @param tokenOut      Intermediate token to arb (e.g., USDC)
     * @param amountIn      Amount of tokenIn to deploy (caller must have approved)
     * @param amountOutMinA Minimum tokenOut from poolA — reverts if not met
     * @param amountOutMinB Minimum tokenIn from poolB — reverts if not met
     * @param poolA         Uniswap V2 pair offering the cheaper tokenOut price
     * @param poolB         Uniswap V2 pair offering the higher tokenOut price
     * @param deadline      Unix timestamp; reverts if block.timestamp exceeds it
     * @return profit       tokenIn amount returned to owner (capital + net gain)
     */
    function executeArbitrage(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMinA,
        uint256 amountOutMinB,
        address poolA,
        address poolB,
        uint256 deadline
    ) external onlyOwner nonReentrant validDeadline(deadline) returns (uint256 profit) {
        if (amountIn == 0) revert ZeroAmount();
        if (tokenIn == address(0) || tokenOut == address(0)) revert InvalidPath();

        // Snapshot balance before pulling capital — used to calculate net return
        uint256 balanceBefore = IERC20(tokenIn).balanceOf(address(this));

        // Pull trading capital from the owner into this contract
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);

        // Leg A: tokenIn → tokenOut on the cheaper pool
        uint256 receivedTokenOut = _executeSwap(tokenIn, amountIn, tokenOut, poolA);
        if (receivedTokenOut < amountOutMinA) revert SwapFailed(poolA);

        // Leg B: tokenOut → tokenIn on the more expensive pool
        uint256 receivedTokenIn = _executeSwap(tokenOut, receivedTokenOut, tokenIn, poolB);
        if (receivedTokenIn < amountOutMinB) revert SwapFailed(poolB);

        // profit = everything above the pre-arb snapshot (includes returned capital)
        profit = IERC20(tokenIn).balanceOf(address(this)) - balanceBefore;
        if (profit == 0) revert InsufficientProfit(1, 0);

        IERC20(tokenIn).transfer(msg.sender, profit);

        emit ArbitrageExecuted(tokenIn, tokenOut, amountIn, profit, block.number);
    }

    /**
     * @notice Calculates the output of a Uniswap V2 constant-product swap
     * @dev Applies the 0.3 % fee: amountOut = (amountIn × 997 × reserveOut)
     *      / (reserveIn × 1000 + amountIn × 997).
     *      Pure function — safe to call anywhere without side effects.
     * @param amountIn   Input token amount
     * @param reserveIn  Pool reserve of the input token
     * @param reserveOut Pool reserve of the output token
     * @return amountOut Expected output after the 0.3 % fee
     */
    function getAmountOut(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut
    ) public pure returns (uint256 amountOut) {
        uint256 amountInWithFee = amountIn * 997;
        uint256 numerator       = amountInWithFee * reserveOut;
        uint256 denominator     = (reserveIn * 1000) + amountInWithFee;
        amountOut = numerator / denominator;
    }

    /**
     * @notice Recovers any ERC20 tokens stuck in this contract
     * @dev Covers tokens stranded by failed arb attempts or accidental direct transfers.
     * @param token     ERC20 contract address to rescue
     * @param amount    Number of tokens to transfer out
     * @param recipient Address that receives the rescued tokens
     */
    function emergencyWithdraw(
        address token,
        uint256 amount,
        address recipient
    ) external onlyOwner {
        IERC20(token).transfer(recipient, amount);
        emit EmergencyWithdraw(token, amount, recipient);
    }

    /**
     * @notice Accepts ETH sent directly to this contract (e.g., from WETH unwraps)
     */
    receive() external payable {}

    // ── Private Helpers ──────────────────────────────────────────────────────

    /**
     * @notice Executes a single Uniswap V2 swap leg
     * @dev Determines token ordering, calculates amountOut via getAmountOut,
     *      sends tokenIn to the pool, then calls swap().
     *      Extracted into a private function to keep executeArbitrage below the
     *      EVM stack limit of 16 slots.
     * @param tokenIn   Token being sold into the pool
     * @param amountIn  Amount of tokenIn already held by this contract to sell
     * @param tokenOut  Token expected back from the pool
     * @param pool      Uniswap V2 pair address
     * @return received Actual amount of tokenOut received
     */
    function _executeSwap(
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        address pool
    ) private returns (uint256 received) {
        (uint112 r0, uint112 r1,) = IUniswapV2Pair(pool).getReserves();
        address t0 = IUniswapV2Pair(pool).token0();

        uint256 amount0Out;
        uint256 amount1Out;

        if (tokenIn == t0) {
            // tokenIn is token0 → output is token1
            amount0Out = 0;
            amount1Out = getAmountOut(amountIn, uint256(r0), uint256(r1));
        } else {
            // tokenIn is token1 → output is token0
            amount0Out = getAmountOut(amountIn, uint256(r1), uint256(r0));
            amount1Out = 0;
        }

        uint256 balBefore = IERC20(tokenOut).balanceOf(address(this));

        // V2 pattern: deposit input tokens into the pool, then trigger swap
        IERC20(tokenIn).transfer(pool, amountIn);
        IUniswapV2Pair(pool).swap(amount0Out, amount1Out, address(this), "");

        received = IERC20(tokenOut).balanceOf(address(this)) - balBefore;
    }
}
