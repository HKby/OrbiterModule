import BigNumber from 'bignumber.js'
import { Provider } from 'starknet'
import { compileCalldata } from 'starknet/dist/utils/stark'
import { Startknet } from '../chain/starknet.service'
import {
  AddressMapTransactions,
  ITransaction,
  QueryTxFilter,
  Transaction,
  TransactionStatus,
} from '../types'
import { equals } from '../utils'
import logger from '../utils/logger'
import AbstractWatch from './base.watch'
export default class StarknetWatch extends AbstractWatch {
  minConfirmations: number = 1
  constructor(public readonly chain: Startknet) {
    super(chain)
  }
  public getApiFilter(address: string): Promise<QueryTxFilter> {
    throw new Error('Method not implemented.')
  }
  private fixFillAddress(address: string) {
    if (address.length == 65) {
      return `0x0${address.substring(2)}`
    }
    return address
  }
  public async replayBlockTransaction(
    hashOrTx: string | any
  ): Promise<AddressMapTransactions> {
    const txmap: AddressMapTransactions = new Map()
    let originTx =
      typeof hashOrTx === 'string'
        ? await (
            await this.chain.provider.getTransaction(hashOrTx)
          ).transaction
        : hashOrTx
    try {
      const from = this.fixFillAddress(originTx['contract_address'])
      let isMatchTx = await this.isWatchWalletAddress(from)
      const { transaction_hash, ...extra } = originTx
      const chainConfig = this.chain.chainConfig
      const TxData = new Transaction({
        chainId: chainConfig.chainId,
        hash: transaction_hash,
        from,
        to: '',
        value: new BigNumber(0),
        nonce: 0,
        blockHash: '',
        blockNumber: 0,
        transactionIndex: 0,
        gas: 0,
        gasPrice: 0,
        fee: 0,
        feeToken: chainConfig.nativeCurrency.symbol,
        input: '',
        symbol: '',
        tokenAddress: '',
        status: TransactionStatus.Fail,
        timestamp: 0,
        extra,
        source: 'rpc',
      })
      if (originTx.calldata.length === 12) {
        // match2
        const recipientAddr = this.fixFillAddress(originTx.calldata[7])
        if (await this.isWatchWalletAddress(recipientAddr)) {
          const tokenAddr = this.fixFillAddress(originTx.calldata[6])
          const forwardContractAddr = this.fixFillAddress(originTx.calldata[1])
          if (
            (await this.isWatchTokenAddress(tokenAddr)) &&
            (await this.isWatchContractAddress(forwardContractAddr))
          ) {
            TxData.symbol = await this.chain.getTokenSymbol(tokenAddr)
            TxData.tokenAddress = tokenAddr
            TxData.to = recipientAddr
            const nonce = originTx.calldata[11]
            TxData.nonce = Number(nonce)
            TxData.extra['ext'] = originTx.calldata[10]
            TxData.value = new BigNumber(originTx.calldata[8])
            isMatchTx = true
          }
        }
      } else if (originTx.calldata.length === 10) {
        const recipientAddr = this.fixFillAddress(originTx.calldata[6])
        if (await this.isWatchWalletAddress(recipientAddr)) {
          const tokenAddr = this.fixFillAddress(originTx.calldata[1])
          if (await this.isWatchTokenAddress(tokenAddr)) {
            TxData.symbol = await this.chain.getTokenSymbol(tokenAddr)
            TxData.tokenAddress = tokenAddr
            TxData.to = recipientAddr
            const nonce = originTx.calldata[9]
            TxData.nonce = Number(nonce)
            TxData.value = new BigNumber(originTx.calldata[7])
            isMatchTx = true
          }
        }
      }
      if (!isMatchTx || !TxData.from || !TxData.to) {
        return txmap
      }
      let matchAddress = ''
      if (await this.isWatchWalletAddress(TxData.from)) {
        matchAddress = TxData.from
      } else if (await this.isWatchWalletAddress(TxData.to)) {
        matchAddress = TxData.to
      }
      if (!matchAddress) {
        logger.info(
          `[${this.chain.chainConfig.name}] Matched but the resolved transaction failed to match: Addrss=${matchAddress}`,
          JSON.stringify(TxData)
        )
        return txmap
      }
      matchAddress = matchAddress.toLowerCase()
      logger.info(
        `[${this.chain.chainConfig.name}] replayBlock Match Transaction:Addrss=${matchAddress},matchAddress Hash=${originTx.hash}`
      )
      if (!txmap.has(matchAddress)) txmap.set(matchAddress, [])
      txmap.get(matchAddress)?.push(TxData)
      return txmap
    } catch (error) {
      throw error
    }
    return txmap
  }
  public async replayBlock(
    start: number,
    end: number,
    changeBlock?: Function
  ): Promise<{ start: number; end: number }> {
    try {
      const provider = this.chain.provider
      const config = this.chain.chainConfig
      config.debug &&
        logger.info(
          `[${config.name} - Start replayBlock ${start}/${
            end - this.minConfirmations
          }/${end}`
        )
      while (start <= end - this.minConfirmations) {
        try {
          let timestamp = Date.now()
          config.debug &&
            logger.debug(
              `[${
                config.name
              } - replayBlock - GgetBlockBefore] Block:${start}/${
                end - this.minConfirmations
              }/${end},, timestamp:${timestamp}`
            )
          const block = await provider.getBlock(start)
          config.debug &&
            logger.debug(
              `[${config.name} - replayBlock - GetBlockAfter] Block:${start}/${
                end - this.minConfirmations
              }/${end}, timestamp:${timestamp},Spend time:${
                (Date.now() - timestamp) / 1000 + '/s'
              }`
            )
          if (block) {
            const transactions = block.transactions as unknown as Array<any>
            config.debug &&
              logger.info(
                `[${config.name}] replayBlock (${start}/${
                  end - this.minConfirmations
                }/${end}), Trxs Count : ${transactions.length}`
              )
            const txmap: AddressMapTransactions = new Map()
            for (const tx of transactions.filter(
              (tx) => tx.type === 'INVOKE_FUNCTION'
            )) {
              //   // Filter non whitelist address transactions
              // if (
              //   tx.transaction_hash !=
              //   '0x5ec09c04e223ec0c07f0bbb4d19737bbefcf58361812f1405017c19ae5b175f'
              // ) {
              //   continue
              // }
              const matchTxList = await this.replayBlockTransaction(tx)
              matchTxList.forEach((txlist, address) => {
                if (!txmap.has(address)) txmap.set(address, [])
                txlist.forEach((tx) => {
                  tx.blockHash = block.block_hash
                  tx.blockNumber = block.block_number
                  tx.timestamp = block.timestamp
                  const transactionReceipts =
                    block.transaction_receipts as unknown as Array<any>
                  const transactionReceipt = transactionReceipts.find((row) =>
                    equals(row.transaction_hash, tx.hash)
                  )
                  if (transactionReceipt) {
                    tx.fee = Number(transactionReceipt['actual_fee'])
                  }
                })
                txmap.get(address)?.push(...txlist)
              })
            }
            changeBlock && changeBlock(start, txmap)
            config.debug &&
              logger.debug(
                `[${
                  config.name
                } - replayBlock - complete] Block:${start}, Latest:${end}, Next Block:${
                  start + 1
                }, timestamp:${timestamp},Spend time:${
                  (Date.now() - timestamp) / 1000 + '/s'
                }`
              )
            start++
          }
        } catch (error) {
          console.error(error)
          logger.error(`[${config.name}] replayBlock Error:`, error.message)
        }
      }
      return { start, end }
    } catch (error) {
      throw error
    }
  }
}
