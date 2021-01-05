import Vue from 'vue'
import Vuex from 'vuex'

import * as bip39 from 'bip39'

import Assets from './modules/assets/assets'
import Network from './modules/network/network'
import Notifications from './modules/notifications/notifications'
import History from './modules/history/history'
import Platform from './modules/platform/platform'
import Ledger from './modules/ledger/ledger'

import { RootState, IssueBatchTxInput, ImportKeyfileInput, ExportWalletsInput } from '@/store/types'

import { KeyFile, KeyFileDecrypted } from '@/js/IKeystore'

Vue.use(Vuex)

import router from '@/router'

import { ava, avm, bintools } from '@/AVA'
import AvaHdWallet from '@/js/wallets/AvaHdWallet'

import { Buffer } from 'avalanche'
import { UnixNow } from 'avalanche/dist/utils'
import {
    UTXO,
    KeyPair as AVMKeyPair,
    AmountOutput,
    UTXOSet,
    NFTMintOutput,
    AVMConstants,
} from 'avalanche/dist/apis/avm'
import { UTXOSet as PlatformUTXOSet } from 'avalanche/dist/apis/platformvm'

import AvaAsset from '@/js/AvaAsset'
import { KEYSTORE_VERSION, makeKeyfile, readKeyFile } from '@/js/Keystore'
import { AssetsDict } from '@/store/modules/assets/types'
import { keyToKeypair } from '@/helpers/helper'
import BN from 'bn.js'
import { LedgerWallet } from '@/js/wallets/LedgerWallet'
import { NetworkItem } from '@/store/modules/network/types'
import { AvaNetwork } from '@/js/AvaNetwork'
import { StakeableLockOut } from 'avalanche/dist/apis/platformvm'
import { wallet_api } from '@/wallet_api'
import { SingletonWallet } from '@/js/wallets/SingletonWallet'

export default new Vuex.Store({
    modules: {
        Assets,
        Notifications,
        Network,
        History,
        Platform,
        Ledger,
    },
    state: {
        isAuth: false,
        activeWallet: null,
        address: null, // current active derived address
        wallets: [],
        volatileWallets: [], // will be forgotten when tab is closed
        warnUpdateKeyfile: false, // If true will promt the user the export a new keyfile
        prices: {
            usd: 0,
        },
    },
    getters: {
        addresses(state: RootState): string[] {
            let wallet = state.activeWallet
            if (!wallet) return []
            let addresses = wallet.getDerivedAddresses()
            return addresses
        },
    },
    mutations: {
        updateActiveAddress(state) {
            if (!state.activeWallet) {
                state.address = null
            } else {
                let addrNow = state.activeWallet.getCurrentAddress()
                state.address = addrNow
            }
        },
    },
    actions: {
        // Used in home page to access a user's wallet
        // Used to access wallet with a single key
        // TODO rename to accessWalletMenmonic
        async accessWallet({ state, dispatch, commit }, mnemonic: string): Promise<AvaHdWallet> {
            let wallet: AvaHdWallet = await dispatch('addWallet', mnemonic)
            await dispatch('activateWallet', wallet)

            dispatch('onAccess')
            return wallet
        },

        async accessWalletMultiple({ state, dispatch, commit }, mnemonics: string[]) {
            for (var i = 0; i < mnemonics.length; i++) {
                let mnemonic = mnemonics[i]
                await dispatch('addWallet', mnemonic)
            }

            await dispatch('activateWallet', state.wallets[0])

            dispatch('onAccess')
        },

        async accessWalletLedger({ state, dispatch }, wallet: LedgerWallet) {
            state.wallets = [wallet]

            await dispatch('activateWallet', wallet)

            dispatch('onAccess')
        },

        async accessWalletSingleton({ state, dispatch }, wallet: SingletonWallet) {
            state.wallets.push(wallet)

            await dispatch('activateWallet', wallet)

            dispatch('onAccess')
        },

        async onAccess(store) {
            store.state.isAuth = true

            store.dispatch('Assets/updateAvaAsset')
            store.dispatch('Platform/update')
            router.push('/wallet')
            store.dispatch('Assets/updateUTXOs')
        },

        // Similar to logout but keeps the Remembered keys.
        async timeoutLogout(store) {
            store.dispatch('removeAllKeys')
            await store.dispatch('Notifications/add', {
                title: 'Session Timeout',
                message: 'You are logged out due to inactivity.',
                type: 'warning',
            })

            // Remove other data
            store.state.isAuth = false
            store.state.activeWallet = null
            store.state.address = null

            await store.dispatch('Assets/onlogout')
            await store.commit('History/clear')

            router.push('/')
        },

        async logout(store) {
            // Delete keys
            store.dispatch('removeAllKeys')

            // Clear local storage
            localStorage.removeItem('w')

            // Remove other data
            store.state.isAuth = false
            store.state.activeWallet = null
            store.state.address = null

            // Clear Assets
            await store.dispatch('Assets/onlogout')
            await store.commit('History/clear')

            router.push('/')
        },

        // used with logout
        async removeAllKeys({ state, dispatch }) {
            let wallets = state.wallets

            while (wallets.length > 0) {
                let wallet = wallets[0]
                await dispatch('removeWallet', wallet)

                dispatch('Notifications/add', {
                    title: 'Key Removed',
                    message: 'Private key and assets removed from the wallet.',
                })
            }

            state.wallets = []
            state.volatileWallets = []
        },

        async addWallet({ state, dispatch }, mnemonic: string): Promise<AvaHdWallet | null> {
            // Cannot add mnemonic wallets on ledger mode
            if (state.activeWallet?.type === 'ledger') return null

            // Make sure wallet doesnt exist already
            for (var i = 0; i < state.wallets.length; i++) {
                let w = state.wallets[i] as AvaHdWallet
                if (w.mnemonic === mnemonic) {
                    console.error('WALLET ALREADY ADDED')
                    return null
                }
            }
            let wallet = new AvaHdWallet(mnemonic)
            state.wallets.push(wallet)
            state.volatileWallets.push(wallet)
            return wallet
        },

        removeWallet({ state, dispatch }, wallet: AvaHdWallet) {
            // TODO: This might cause an error use wallet id instead
            let index = state.wallets.indexOf(wallet)
            state.wallets.splice(index, 1)
        },

        // Creates a keystore file and saves to local storage
        async rememberWallets({ state, dispatch }, pass: string | undefined) {
            if (!pass || state.activeWallet?.type === 'ledger') return

            let wallets = state.wallets as AvaHdWallet[]

            let file = await makeKeyfile(wallets, pass)
            let fileString = JSON.stringify(file)
            localStorage.setItem('w', fileString)

            dispatch('Notifications/add', {
                title: 'Remember Wallet',
                message: 'Wallets are stored securely for easy access.',
                type: 'info',
            })

            // No more voltile wallets
            state.volatileWallets = []
        },

        async issueBatchTx({ state }, data: IssueBatchTxInput) {
            let wallet = state.activeWallet
            if (!wallet) return 'error'

            let toAddr = data.toAddress
            let orders = data.orders
            let memo = data.memo

            try {
                let txId: string = await wallet.issueBatchTx(orders, toAddr, memo)
                return txId
            } catch (e) {
                throw e
            }
        },

        async activateWallet({ state, dispatch, commit }, wallet: AvaHdWallet | LedgerWallet) {
            state.activeWallet = wallet

            dispatch('Assets/updateAvaAsset')
            commit('updateActiveAddress')
            dispatch('History/updateTransactionHistory')
        },

        async exportWallets({ state }, input: ExportWalletsInput) {
            let pass = input.password
            let wallets = input.wallets

            let file_data = await makeKeyfile(wallets, pass)

            // Download the file
            let text = JSON.stringify(file_data)
            // let addr = file_data.keys[0].address.substr(2,5);

            let utcDate = new Date()
            let dateString = utcDate.toISOString().replace(' ', '_')
            let filename = `AVAX_${dateString}.json`

            var blob = new Blob([text], {
                type: 'application/json',
            })
            let url = URL.createObjectURL(blob)
            var element = document.createElement('a')

            element.setAttribute('href', url)
            element.setAttribute('download', filename)
            element.style.display = 'none'
            document.body.appendChild(element)
            element.click()
            document.body.removeChild(element)
        },

        // Given a key file with password, will try to decrypt the file and add keys to user's
        // key chain
        async importKeyfile(store, data: ImportKeyfileInput) {
            let pass = data.password
            let fileData = data.data

            let version = fileData.version

            try {
                // Decrypt the key file with the password
                let keyFile: KeyFileDecrypted = await readKeyFile(fileData, pass)

                // Old files have private keys, 5.0 and above has mnemonic phrases
                let keys = keyFile.keys

                let chainID = avm.getBlockchainAlias()

                let mnemonics: string[]
                // Convert old version private keys to mnemonic phrases
                if (['2.0', '3.0', '4.0'].includes(version)) {
                    mnemonics = keys.map((key) => {
                        // Private keys from the keystore file do not have the PrivateKey- prefix
                        let pk = 'PrivateKey-' + key.key
                        let keypair = keyToKeypair(pk, chainID)

                        let keyBuf = keypair.getPrivateKey()
                        let keyHex: string = keyBuf.toString('hex')

                        // Entropy must be 64 characters, make sure 0 pad exists
                        let paddedKeyHex = keyHex.padStart(64, '0')
                        let mnemonic: string = bip39.entropyToMnemonic(paddedKeyHex)

                        return mnemonic
                    })
                } else {
                    // New versions encrypt the mnemonic so we dont have to do anything
                    mnemonics = keys.map((key) => key.key)
                }

                // If not auth, login user then add keys
                if (!store.state.isAuth) {
                    await store.dispatch('accessWalletMultiple', mnemonics)
                } else {
                    for (let i = 0; i < mnemonics.length; i++) {
                        // Private keys from the keystore file do not have the PrivateKey- prefix
                        let mnemonic = mnemonics[i]
                        await store.dispatch('addWallet', mnemonic)
                    }
                }

                // Keystore warning flag asking users to update their keystore files;
                store.state.warnUpdateKeyfile = false
                if (version !== KEYSTORE_VERSION) {
                    store.state.warnUpdateKeyfile = true
                }

                return {
                    success: true,
                    message: 'success',
                }
            } catch (err) {
                throw err
            }
        },

        async updateAvaxPrice(store) {
            wallet_api.get('/price').then((res) => {
                let prices = res.data
                store.state.prices = prices
            })
        },
    },
})
