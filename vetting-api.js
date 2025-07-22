import dotenv from 'dotenv';
dotenv.config();

import cors from 'cors';
import express from 'express';
import fetch from 'node-fetch';

// Polyfills for Node.js 16 compatibility
if (!Object.hasOwn) {
  Object.hasOwn = function(obj, prop) {
    return Object.prototype.hasOwnProperty.call(obj, prop);
  };
}

// Polyfill for btoa (base64 encoding)
if (typeof btoa === 'undefined') {
  global.btoa = function(str) {
    return Buffer.from(str, 'binary').toString('base64');
  };
}

// Polyfill for atob (base64 decoding)
if (typeof atob === 'undefined') {
  global.atob = function(str) {
    return Buffer.from(str, 'base64').toString('binary');
  };
}

// Use older compatible imports for Sui.js
import { SuiClient, SuiHTTPTransport, getFullnodeUrl } from '@mysten/sui.js/client';
import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519';
import { TransactionBlock } from '@mysten/sui.js/transactions';

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize Sui client with explicit fetch implementation for Node.js 16
const suiClient = new SuiClient({
  transport: new SuiHTTPTransport({
    url: process.env.SUI_RPC_URL || getFullnodeUrl('mainnet'),
    fetch: fetch, // Explicitly provide node-fetch
  }),
});

function getMasterKeypair() {
  const mnemonic = process.env.MASTER_MNEMONIC;
  if (!mnemonic) throw new Error('MASTER_MNEMONIC is not set');
  return Ed25519Keypair.deriveKeypair(mnemonic);
}

function generateOrganizationId() {
  return `BRAAV_${Date.now()}_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'Vetting Table API is running', 
    timestamp: new Date().toISOString(),
    nodeVersion: process.version
  });
});

// IMPORTANT: Put the initialize POST route BEFORE the generic GET route
app.post('/api/vetting-table/initialize', async (req, res) => {
  try {
    // Check environment variables
    const PACKAGE_ID = process.env.PACKAGE_ID;
    const MASTER_MNEMONIC = process.env.MASTER_MNEMONIC;
    
    if (!PACKAGE_ID) {
      console.error('PACKAGE_ID is not set in environment variables');
      return res.status(500).json({ 
        success: false, 
        error: 'PACKAGE_ID environment variable is not set',
        envCheck: {
          PACKAGE_ID: !!PACKAGE_ID,
          MASTER_MNEMONIC: !!MASTER_MNEMONIC,
          SUI_RPC_URL: !!process.env.SUI_RPC_URL
        }
      });
    }

    if (!MASTER_MNEMONIC) {
      console.error('MASTER_MNEMONIC is not set in environment variables');
      return res.status(500).json({ 
        success: false, 
        error: 'MASTER_MNEMONIC environment variable is not set',
        envCheck: {
          PACKAGE_ID: !!PACKAGE_ID,
          MASTER_MNEMONIC: !!MASTER_MNEMONIC,
          SUI_RPC_URL: !!process.env.SUI_RPC_URL
        }
      });
    }

    console.log('Environment check passed:', {
      PACKAGE_ID: PACKAGE_ID.substring(0, 10) + '...',
      MASTER_MNEMONIC_SET: !!MASTER_MNEMONIC,
      SUI_RPC_URL: process.env.SUI_RPC_URL || 'using default'
    });

    const keypair = getMasterKeypair();
    const organizationId = generateOrganizationId();
    const creatorAddress = keypair.getPublicKey().toSuiAddress();

    console.log('Creating transaction for address:', creatorAddress);

    const tx = new TransactionBlock();

    // Add the move call to initialize vetting table
    tx.moveCall({
      target: `${PACKAGE_ID}::vetting::initialize_vetting_table`,
      arguments: [],
    });

    console.log('Signing and executing transaction...');

    // Sign and execute transaction with Node.js 16 compatible options
    const result = await suiClient.signAndExecuteTransactionBlock({
      transactionBlock: tx,
      signer: keypair,
      options: { 
        showObjectChanges: true,
        showEffects: true,
        showEvents: true
      },
    });

    console.log('Transaction executed:', result.digest);
    console.log('Object changes:', JSON.stringify(result.objectChanges, null, 2));

    // Find the created VettingTable object
    let vettingTableId = null;
    if (result.objectChanges) {
      const vettingTableChange = result.objectChanges.find(
        (change) => change.type === 'created' && 
                   change.objectType && 
                   change.objectType.includes('VettingTable')
      );
      vettingTableId = vettingTableChange?.objectId;
      console.log('Found vetting table ID:', vettingTableId);
    }

    if (!vettingTableId) {
      console.error('Transaction result:', JSON.stringify(result, null, 2));
      return res.status(500).json({ 
        success: false, 
        error: 'VettingTable object not found in transaction results',
        transactionDigest: result.digest,
        objectChanges: result.objectChanges,
        debug: {
          hasObjectChanges: !!result.objectChanges,
          objectChangesCount: result.objectChanges ? result.objectChanges.length : 0
        }
      });
    }

    res.json({
      success: true,
      data: {
        organizationId,
        creatorAddress,
        vettingTableId,
        vettingStatus: 'INITIALIZED',
        transactionDigest: result.digest,
        timestamp: new Date().toISOString(),
        network: process.env.SUI_RPC_URL || 'mainnet',
      },
    });

  } catch (error) {
    console.error('Error initializing vetting table:', error);
    console.error('Error stack:', error.stack);
    
    // More detailed error handling for debugging
    const errorMessage = error.message || 'Failed to initialize vetting table';
    const errorDetails = {
      success: false,
      error: errorMessage,
      timestamp: new Date().toISOString(),
      debug: {
        errorName: error.name,
        errorCode: error.code,
        envVarsSet: {
          PACKAGE_ID: !!process.env.PACKAGE_ID,
          MASTER_MNEMONIC: !!process.env.MASTER_MNEMONIC,
          SUI_RPC_URL: !!process.env.SUI_RPC_URL
        }
      }
    };

    // Add more context if it's a Sui-specific error
    if (error.code) {
      errorDetails.errorCode = error.code;
    }
    
    if (error.cause) {
      errorDetails.cause = error.cause;
    }

    res.status(500).json(errorDetails);
  }
});

// PUT the GET route AFTER the POST initialize route to avoid conflicts
app.get('/api/vetting-table/:tableId', async (req, res) => {
  try {
    const { tableId } = req.params;
    
    // Prevent confusion with the initialize endpoint
    if (tableId === 'initialize') {
      return res.status(400).json({
        success: false,
        error: 'To initialize a vetting table, use POST /api/vetting-table/initialize',
        hint: 'This endpoint is for getting existing tables. Use a valid Sui object ID.'
      });
    }
    
    if (!tableId) {
      return res.status(400).json({
        success: false,
        error: 'Table ID is required'
      });
    }

    // Validate Sui object ID format (should be 0x followed by 64 hex characters)
    const suiObjectIdRegex = /^0x[a-fA-F0-9]{64}$/;
    if (!suiObjectIdRegex.test(tableId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid Sui Object ID format. Must be 0x followed by 64 hex characters',
        providedId: tableId,
        example: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
      });
    }

    // Get the vetting table object
    const vettingTable = await suiClient.getObject({
      id: tableId,
      options: { showContent: true, showType: true }
    });

    if (!vettingTable.data) {
      return res.status(404).json({
        success: false,
        error: 'Vetting table not found',
        tableId: tableId
      });
    }

    res.json({
      success: true,
      data: {
        tableId,
        vettingTable: vettingTable.data,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Error fetching vetting table:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch vetting table',
      tableId: req.params.tableId
    });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    timestamp: new Date().toISOString()
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    availableEndpoints: [
      'GET /health',
      'POST /api/vetting-table/initialize',
      'GET /api/vetting-table/:tableId'
    ]
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Vetting Table API running at http://localhost:${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
  console.log(`🏛️ Initialize table: POST http://localhost:${PORT}/api/vetting-table/initialize`);
  console.log(`📋 Get table: GET http://localhost:${PORT}/api/vetting-table/:tableId`);
  console.log(`🔧 Node.js version: ${process.version}`);
});