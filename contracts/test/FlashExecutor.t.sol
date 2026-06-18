// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title FlashExecutorTest
 * @notice Comprehensive test suite for FlashExecutor.sol
 * @dev Uses Forge's cheatcodes for state manipulation and event assertions.
 *      Fuzz tests verify mathematical properties hold across the full input domain.
 *      MockERC20 and MockUniswapV2Pair are co-located here to keep the suite self-contained.
 */

import {Test, console} from "forge-std/Test.sol";
import {FlashExecutor} from "../src/FlashExecutor.sol";

// ─── Mock ERC20 ───────────────────────────────────────────────────────────────

/**
 * @title MockERC20
 * @notice Minimal ERC20 implementation with an unrestricted mint() for tests
 */
contract MockERC20 {
    string  public name;
    string  public symbol;
    uint8   public decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256)                     public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory _name, string memory _symbol) {
        name   = _name;
        symbol = _symbol;
    }

    /// @notice Mints `amount` tokens to `to` — no access control, test use only
    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply    += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "ERC20: insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to]         += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "ERC20: insufficient balance");
        require(allowance[from][msg.sender] >= amount, "ERC20: insufficient allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from]             -= amount;
        balanceOf[to]               += amount;
        emit Transfer(from, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }
}

// ─── Mock Uniswap V2 Pair ────────────────────────────────────────────────────

/**
 * @title MockUniswapV2Pair
 * @notice Realistic Uniswap V2 pair mock that applies the constant-product formula
 * @dev Uses the standard (x*997*y) / (x*1000 + dx*997) swap math so tests exercise
 *      the same arithmetic as the real protocol.
 */
contract MockUniswapV2Pair {
    address public token0addr;
    address public token1addr;
    uint112 public reserve0;
    uint112 public reserve1;

    constructor(address _token0, address _token1, uint112 _reserve0, uint112 _reserve1) {
        token0addr = _token0;
        token1addr = _token1;
        reserve0   = _reserve0;
        reserve1   = _reserve1;
    }

    function token0() external view returns (address) { return token0addr; }
    function token1() external view returns (address) { return token1addr; }

    function getReserves()
        external
        view
        returns (uint112 r0, uint112 r1, uint32 ts)
    {
        return (reserve0, reserve1, uint32(block.timestamp));
    }

    /**
     * @notice Executes a Uniswap V2-style swap using the constant-product formula
     * @dev Caller must have already transferred the input tokens into this contract
     *      before calling swap() — mirrors the real V2 interface.
     */
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata) external {
        require(amount0Out > 0 || amount1Out > 0, "MockPair: zero output");

        if (amount0Out > 0) {
            // Sending token0 out, receiving token1 in
            uint256 received = MockERC20(token1addr).balanceOf(address(this)) - uint256(reserve1);
            uint256 expected = _getAmountOut(received, uint256(reserve1), uint256(reserve0));
            require(amount0Out <= expected, "MockPair: insufficient input for amount0Out");
            MockERC20(token0addr).transfer(to, amount0Out);
            reserve0 = uint112(uint256(reserve0) - amount0Out);
            reserve1 = uint112(uint256(reserve1) + received);
        } else {
            // Sending token1 out, receiving token0 in
            uint256 received = MockERC20(token0addr).balanceOf(address(this)) - uint256(reserve0);
            uint256 expected = _getAmountOut(received, uint256(reserve0), uint256(reserve1));
            require(amount1Out <= expected, "MockPair: insufficient input for amount1Out");
            MockERC20(token1addr).transfer(to, amount1Out);
            reserve1 = uint112(uint256(reserve1) - amount1Out);
            reserve0 = uint112(uint256(reserve0) + received);
        }
    }

    /// @dev Internal copy of the Uniswap V2 getAmountOut formula
    function _getAmountOut(uint256 amountIn, uint256 resIn, uint256 resOut)
        internal
        pure
        returns (uint256)
    {
        uint256 fee = amountIn * 997;
        return (fee * resOut) / (resIn * 1000 + fee);
    }
}

// ─── Test Contract ────────────────────────────────────────────────────────────

contract FlashExecutorTest is Test {
    // ── Fixtures ─────────────────────────────────────────────────────────────

    FlashExecutor      internal executor;
    MockERC20          internal tokenA;   // tokenIn  (e.g., WETH)
    MockERC20          internal tokenB;   // tokenOut (e.g., USDC)
    MockUniswapV2Pair  internal poolA;    // cheap tokenB  — 1 tokenA : 3 tokenB
    MockUniswapV2Pair  internal poolB;    // pricier tokenA — 1 tokenB : 0.4 tokenA (≈2.5x)

    // Mint amounts
    uint256 constant OWNER_CAPITAL    = 10_000 ether;
    uint256 constant POOL_A_RESERVE_A = 100_000 ether;  // reserve0: tokenA
    uint256 constant POOL_A_RESERVE_B = 300_000 ether;  // reserve1: tokenB  (ratio 1:3)
    uint256 constant POOL_B_RESERVE_B = 300_000 ether;  // reserve0: tokenB
    uint256 constant POOL_B_RESERVE_A = 120_000 ether;  // reserve1: tokenA  (ratio 1:0.4)

    function setUp() public {
        // Deploy tokens
        tokenA = new MockERC20("TokenA", "TKA");
        tokenB = new MockERC20("TokenB", "TKB");

        // Deploy executor — test contract is the owner
        executor = new FlashExecutor();

        // poolA: tokenA cheaper → tokenB (token0 = tokenA, token1 = tokenB)
        poolA = new MockUniswapV2Pair(
            address(tokenA),
            address(tokenB),
            uint112(POOL_A_RESERVE_A),
            uint112(POOL_A_RESERVE_B)
        );

        // poolB: sell tokenB for tokenA at better rate (token0 = tokenB, token1 = tokenA)
        poolB = new MockUniswapV2Pair(
            address(tokenB),
            address(tokenA),
            uint112(POOL_B_RESERVE_B),
            uint112(POOL_B_RESERVE_A)
        );

        // Fund pools with actual tokens
        tokenA.mint(address(poolA), POOL_A_RESERVE_A);
        tokenB.mint(address(poolA), POOL_A_RESERVE_B);
        tokenB.mint(address(poolB), POOL_B_RESERVE_B);
        tokenA.mint(address(poolB), POOL_B_RESERVE_A);

        // Fund the owner (test contract) with capital
        tokenA.mint(address(this), OWNER_CAPITAL);

        // Approve executor to pull capital
        tokenA.approve(address(executor), type(uint256).max);
    }

    // ── Unit Tests ────────────────────────────────────────────────────────────

    /**
     * @notice Happy-path: profitable two-leg arb with a genuine price spread.
     * @dev poolA ratio 1:3 and poolB ratio ~1:0.4 creates a spread where buying
     *      tokenB cheap on poolA and selling on poolB returns more tokenA.
     */
    function test_executeArbitrage_profitableSwap() public {
        uint256 amountIn = 1_000 ether;

        // Pre-compute expected leg-A output to set a reasonable minOut
        uint256 expectedTokenB = executor.getAmountOut(amountIn, POOL_A_RESERVE_A, POOL_A_RESERVE_B);
        // Pre-compute expected leg-B output
        uint256 expectedTokenA = executor.getAmountOut(expectedTokenB, POOL_B_RESERVE_B, POOL_B_RESERVE_A);

        uint256 ownerBefore = tokenA.balanceOf(address(this));

        vm.expectEmit(true, true, false, false);
        emit FlashExecutor.ArbitrageExecuted(
            address(tokenA),
            address(tokenB),
            amountIn,
            expectedTokenA,
            block.number
        );

        uint256 profit = executor.executeArbitrage(
            address(tokenA),
            address(tokenB),
            amountIn,
            expectedTokenB * 99 / 100,  // 1 % slippage tolerance on leg A
            expectedTokenA * 99 / 100,  // 1 % slippage tolerance on leg B
            address(poolA),
            address(poolB),
            block.timestamp + 300
        );

        uint256 ownerAfter = tokenA.balanceOf(address(this));

        assertGt(profit, 0, "profit must be positive");
        assertEq(ownerAfter, ownerBefore - amountIn + profit, "owner balance accounting");
        assertGt(profit, amountIn * 99 / 100, "should recover at least 99 % of capital");
    }

    /// @notice Caller that is not the owner must be rejected
    function test_executeArbitrage_revertsIfNotOwner() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert(FlashExecutor.NotOwner.selector);
        executor.executeArbitrage(
            address(tokenA), address(tokenB),
            1 ether, 0, 0,
            address(poolA), address(poolB),
            block.timestamp + 300
        );
    }

    /// @notice Deadline in the past must revert
    function test_executeArbitrage_revertsOnExpiredDeadline() public {
        vm.warp(block.timestamp + 1000);
        uint256 pastDeadline = block.timestamp - 1;

        vm.expectRevert(FlashExecutor.DeadlineExpired.selector);
        executor.executeArbitrage(
            address(tokenA), address(tokenB),
            1_000 ether, 0, 0,
            address(poolA), address(poolB),
            pastDeadline
        );
    }

    /// @notice amountIn == 0 must revert
    function test_executeArbitrage_revertsOnZeroAmount() public {
        vm.expectRevert(FlashExecutor.ZeroAmount.selector);
        executor.executeArbitrage(
            address(tokenA), address(tokenB),
            0, 0, 0,
            address(poolA), address(poolB),
            block.timestamp + 300
        );
    }

    /// @notice Slippage minimum higher than pool can deliver must revert
    function test_executeArbitrage_revertsOnInsufficientOutput() public {
        uint256 amountIn = 1_000 ether;
        uint256 impossibleMinOut = type(uint256).max; // no pool can satisfy this

        vm.expectRevert(abi.encodeWithSelector(FlashExecutor.SwapFailed.selector, address(poolA)));
        executor.executeArbitrage(
            address(tokenA), address(tokenB),
            amountIn,
            impossibleMinOut, // amountOutMinA: impossible
            0,
            address(poolA), address(poolB),
            block.timestamp + 300
        );
    }

    /// @notice Owner can rescue stuck tokens
    function test_emergencyWithdraw_worksForOwner() public {
        uint256 stuckAmount = 500 ether;
        tokenA.mint(address(executor), stuckAmount);

        uint256 ownerBefore = tokenA.balanceOf(address(this));

        vm.expectEmit(true, false, true, true);
        emit FlashExecutor.EmergencyWithdraw(address(tokenA), stuckAmount, address(this));

        executor.emergencyWithdraw(address(tokenA), stuckAmount, address(this));

        assertEq(tokenA.balanceOf(address(this)), ownerBefore + stuckAmount);
        assertEq(tokenA.balanceOf(address(executor)), 0);
    }

    /// @notice Non-owner emergency withdraw must revert
    function test_emergencyWithdraw_revertsIfNotOwner() public {
        tokenA.mint(address(executor), 100 ether);
        vm.prank(address(0xDEAD));
        vm.expectRevert(FlashExecutor.NotOwner.selector);
        executor.emergencyWithdraw(address(tokenA), 100 ether, address(0xDEAD));
    }

    /// @notice getAmountOut must match the reference formula exactly
    function test_getAmountOut_matchesUniswapFormula() public view {
        uint256 amountIn   = 1_000 ether;
        uint256 reserveIn  = 100_000 ether;
        uint256 reserveOut = 200_000 ether;

        uint256 result = executor.getAmountOut(amountIn, reserveIn, reserveOut);

        // Reference: (amountIn * 997 * reserveOut) / (reserveIn * 1000 + amountIn * 997)
        uint256 expected = (amountIn * 997 * reserveOut) / (reserveIn * 1000 + amountIn * 997);

        assertEq(result, expected, "getAmountOut formula mismatch");
    }

    // ── Fuzz Tests ────────────────────────────────────────────────────────────

    /**
     * @notice Output can never exceed the full reserve — the pool cannot pay more than it holds
     * @param amountIn   Fuzzed input amount
     * @param reserveIn  Fuzzed pool reserve of the input token
     * @param reserveOut Fuzzed pool reserve of the output token
     */
    function test_fuzz_getAmountOut_neverExceedsReserve(
        uint256 amountIn,
        uint112 reserveIn,
        uint112 reserveOut
    ) public view {
        vm.assume(reserveIn  > 0);
        vm.assume(reserveOut > 0);
        vm.assume(amountIn   > 0);
        vm.assume(amountIn   < type(uint128).max);

        uint256 out = executor.getAmountOut(amountIn, uint256(reserveIn), uint256(reserveOut));

        assertLt(out, uint256(reserveOut), "output must be less than reserveOut");
    }

    /**
     * @notice getAmountOut must be monotonically non-decreasing in amountIn
     * @param amountA    Smaller fuzzed input
     * @param amountB    Larger fuzzed input
     * @param reserveIn  Fuzzed reserve of input token
     * @param reserveOut Fuzzed reserve of output token
     */
    function test_fuzz_getAmountOut_increasesMonotonically(
        uint256 amountA,
        uint256 amountB,
        uint112 reserveIn,
        uint112 reserveOut
    ) public view {
        vm.assume(reserveIn  > 0);
        vm.assume(reserveOut > 0);
        vm.assume(amountA    > 0);
        vm.assume(amountB    > amountA);
        vm.assume(amountB    < type(uint128).max);

        uint256 outA = executor.getAmountOut(amountA, uint256(reserveIn), uint256(reserveOut));
        uint256 outB = executor.getAmountOut(amountB, uint256(reserveIn), uint256(reserveOut));

        assertGe(outB, outA, "larger input must yield >= output");
    }

    /**
     * @notice Any caller that is not the owner must be rejected regardless of input
     * @param caller Fuzzed caller address
     */
    function test_fuzz_executeArbitrage_onlyOwnerCanCall(address caller) public {
        vm.assume(caller != address(this)); // address(this) is the owner

        vm.prank(caller);
        vm.expectRevert(FlashExecutor.NotOwner.selector);
        executor.executeArbitrage(
            address(tokenA), address(tokenB),
            1 ether, 0, 0,
            address(poolA), address(poolB),
            block.timestamp + 300
        );
    }
}
