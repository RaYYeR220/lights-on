// Event fragments extracted from the verified VibesTranchEscrow ABI (Base).
// Only what Lights On reads; ContributionMade is used by backer discovery (later task).
export const vibestarterEscrowAbi = [
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "founder",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "string",
        "name": "ipfsCid",
        "type": "string"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "timestamp",
        "type": "uint256"
      }
    ],
    "name": "FounderUpdate",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint8",
        "name": "tranche",
        "type": "uint8"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "timestamp",
        "type": "uint256"
      }
    ],
    "name": "TrancheRequested",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "contributor",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "totalRaised",
        "type": "uint256"
      }
    ],
    "name": "ContributionMade",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "challenger",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint8",
        "name": "tranche",
        "type": "uint8"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "stake",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "string",
        "name": "reason",
        "type": "string"
      }
    ],
    "name": "ChallengeRaised",
    "type": "event"
  }
] as const;

export const founderUpdateEvent = vibestarterEscrowAbi[0];
export const trancheRequestedEvent = vibestarterEscrowAbi[1];
export const contributionMadeEvent = vibestarterEscrowAbi[2];
export const challengeRaisedEvent = vibestarterEscrowAbi[3];

/** View used for backer discovery: per-wallet contribution on an escrow (authoritative; the REST API lags). */
export const vibestarterContributionsAbi = [
  {
    inputs: [{ internalType: 'address', name: '', type: 'address' }],
    name: 'contributions',
    outputs: [
      { internalType: 'uint256', name: 'amount', type: 'uint256' },
      { internalType: 'bool', name: 'refundClaimed', type: 'bool' },
      { internalType: 'bool', name: 'excessClaimed', type: 'bool' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const;
