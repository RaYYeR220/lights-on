// Minimal hand-written ABIs. EAS v1.x interface; IdentityRegistry from erc-8004/erc-8004-contracts abis/IdentityRegistry.json.
export const EAS_ADDRESS = '0x4200000000000000000000000000000000000021' as const;
export const SCHEMA_REGISTRY_ADDRESS = '0x4200000000000000000000000000000000000020' as const;
export const IDENTITY_REGISTRY_ADDRESS = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' as const;

const attestationRequestData = [
  { name: 'recipient', type: 'address' },
  { name: 'expirationTime', type: 'uint64' },
  { name: 'revocable', type: 'bool' },
  { name: 'refUID', type: 'bytes32' },
  { name: 'data', type: 'bytes' },
  { name: 'value', type: 'uint256' },
] as const;

export const easAbi = [
  {
    type: 'function', name: 'attest', stateMutability: 'payable',
    inputs: [{
      type: 'tuple', name: 'request',
      components: [
        { name: 'schema', type: 'bytes32' },
        { type: 'tuple', name: 'data', components: attestationRequestData },
      ],
    }],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function', name: 'multiAttest', stateMutability: 'payable',
    inputs: [{
      type: 'tuple[]', name: 'multiRequests',
      components: [
        { name: 'schema', type: 'bytes32' },
        { type: 'tuple[]', name: 'data', components: attestationRequestData },
      ],
    }],
    outputs: [{ name: '', type: 'bytes32[]' }],
  },
  {
    type: 'function', name: 'getAttestation', stateMutability: 'view',
    inputs: [{ name: 'uid', type: 'bytes32' }],
    outputs: [{
      type: 'tuple', name: '',
      components: [
        { name: 'uid', type: 'bytes32' },
        { name: 'schema', type: 'bytes32' },
        { name: 'time', type: 'uint64' },
        { name: 'expirationTime', type: 'uint64' },
        { name: 'revocationTime', type: 'uint64' },
        { name: 'refUID', type: 'bytes32' },
        { name: 'recipient', type: 'address' },
        { name: 'attester', type: 'address' },
        { name: 'revocable', type: 'bool' },
        { name: 'data', type: 'bytes' },
      ],
    }],
  },
  {
    type: 'event', name: 'Attested',
    inputs: [
      { name: 'recipient', type: 'address', indexed: true },
      { name: 'attester', type: 'address', indexed: true },
      { name: 'uid', type: 'bytes32', indexed: false },
      { name: 'schemaUID', type: 'bytes32', indexed: true },
    ],
  },
] as const;

export const schemaRegistryAbi = [
  {
    type: 'function', name: 'register', stateMutability: 'nonpayable',
    inputs: [
      { name: 'schema', type: 'string' },
      { name: 'resolver', type: 'address' },
      { name: 'revocable', type: 'bool' },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function', name: 'getSchema', stateMutability: 'view',
    inputs: [{ name: 'uid', type: 'bytes32' }],
    outputs: [{
      type: 'tuple', name: '',
      components: [
        { name: 'uid', type: 'bytes32' },
        { name: 'resolver', type: 'address' },
        { name: 'revocable', type: 'bool' },
        { name: 'schema', type: 'string' },
      ],
    }],
  },
] as const;

export const identityRegistryAbi = [
  {
    type: 'function', name: 'register', stateMutability: 'nonpayable',
    inputs: [{ name: 'agentURI', type: 'string' }],
    outputs: [{ name: 'agentId', type: 'uint256' }],
  },
  {
    type: 'function', name: 'ownerOf', stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function', name: 'tokenURI', stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'event', name: 'Registered',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'agentURI', type: 'string', indexed: false },
      { name: 'owner', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event', name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'tokenId', type: 'uint256', indexed: true },
    ],
  },
] as const;
