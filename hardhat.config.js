require('@nomicfoundation/hardhat-toolbox');
require('dotenv').config({ path: '.env.local' });

const { SEPOLIA_RPC_URL, MAINNET_RPC_URL, ROBINHOOD_RPC_URL, ROBINHOOD_TESTNET_RPC_URL, DEPLOYER_PRIVATE_KEY } =
  process.env;

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    compilers: [
      {
        version: '0.8.24',
        settings: {
          optimizer: { enabled: true, runs: 200 },
        },
      },
      {
        // Uniswap V4 (contracts/OnlyAssLaunchpadHook.sol, OnlyAssLaunchpadV4.sol,
        // HookDeployer.sol, contracts/libraries + contracts/interfaces' V4 files)
        // are pinned to this exact version -- matching @uniswap/v4-core's own
        // foundry.toml (`solc = "0.8.26"`) rather than this repo's existing
        // 0.8.24, since V4 relies on transient storage (TLOAD/TSTORE), which
        // needs `evmVersion: "cancun"` to even be emitted. `viaIR` is on for
        // the same reason v4-core's own foundry.toml turns it on: PoolManager's
        // hook-callback flow is deep enough that the legacy codegen hits
        // "stack too deep" without it.
        //
        // IMPORTANT, unverified: this assumes Robinhood Chain's EVM actually
        // supports Cancun opcodes. Nothing in this repo has confirmed that --
        // if the chain only supports an older EVM version, transient-storage
        // opcodes in v4-core's own PoolManager (not code in this repo) would
        // simply not run. Verify this against the chain's own docs/explorer
        // before deploying any of the V4 contracts to it.
        version: '0.8.26',
        settings: {
          optimizer: { enabled: true, runs: 200 },
          evmVersion: 'cancun',
          viaIR: true,
        },
      },
      {
        // Permit2 (bundled inside @uniswap/v4-periphery/lib/permit2, imported
        // as bare "permit2/..." via the node_modules symlink -- see
        // scripts/postinstall-permit2-link.js) is pinned to exactly this
        // version upstream. It's only ever deployed for local Hardhat
        // integration tests here (contracts/test/V4TestDeployment.sol) --
        // production deploys point at Permit2's real canonical deployment,
        // this repo never deploys it itself.
        version: '0.8.17',
        settings: {
          optimizer: { enabled: true, runs: 200 },
          viaIR: true,
        },
      },
    ],
    overrides: {
      // OpenZeppelin 5.6's ERC1155 pulls in Arrays.sol, which uses the
      // Cancun-only MCOPY opcode in a few of its helpers -- solc fails to
      // compile the whole file under the default (pre-Cancun) EVM target
      // even though ERC1155 itself never calls those specific helpers.
      // Same unverified-Robinhood-Chain-EVM-support caveat as the V4
      // compiler entry above applies here too.
      'contracts/OnlyAssCreatorNFT.sol': {
        version: '0.8.24',
        settings: {
          optimizer: { enabled: true, runs: 200 },
          evmVersion: 'cancun',
        },
      },
    },
  },
  networks: {
    hardhat: {},
    ...(SEPOLIA_RPC_URL && DEPLOYER_PRIVATE_KEY
      ? {
          sepolia: {
            url: SEPOLIA_RPC_URL,
            accounts: [DEPLOYER_PRIVATE_KEY],
          },
        }
      : {}),
    ...(MAINNET_RPC_URL && DEPLOYER_PRIVATE_KEY
      ? {
          mainnet: {
            url: MAINNET_RPC_URL,
            accounts: [DEPLOYER_PRIVATE_KEY],
          },
        }
      : {}),
    ...(ROBINHOOD_TESTNET_RPC_URL && DEPLOYER_PRIVATE_KEY
      ? {
          'robinhood-testnet': {
            url: ROBINHOOD_TESTNET_RPC_URL,
            accounts: [DEPLOYER_PRIVATE_KEY],
          },
        }
      : {}),
    ...(ROBINHOOD_RPC_URL && DEPLOYER_PRIVATE_KEY
      ? {
          robinhood: {
            url: ROBINHOOD_RPC_URL,
            accounts: [DEPLOYER_PRIVATE_KEY],
            chainId: 4663,
          },
        }
      : {}),
  },
};
