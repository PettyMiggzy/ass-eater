require('@nomicfoundation/hardhat-toolbox');
require('dotenv').config({ path: '.env.local' });

const { SEPOLIA_RPC_URL, MAINNET_RPC_URL, DEPLOYER_PRIVATE_KEY } = process.env;

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
  },
};
