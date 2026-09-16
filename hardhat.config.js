require('@nomicfoundation/hardhat-toolbox');
require('dotenv').config({ path: '.env.local' });

const { SEPOLIA_RPC_URL, MAINNET_RPC_URL, ROBINHOOD_RPC_URL, ROBINHOOD_TESTNET_RPC_URL, DEPLOYER_PRIVATE_KEY } =
  process.env;

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: '0.8.24',
    settings: {
      optimizer: { enabled: true, runs: 200 },
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
