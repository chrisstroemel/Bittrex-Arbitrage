'use strict'

const request = require('request-promise-native')
const Crypto = require('crypto')
const EventEmitter = require('events')
const assert = require('assert')

const ORDER_TIMEOUT_INTERVAL = 5 * 1000 //5 seconds
const MIN_BTC_TRADE_VALUE = 0.001
const FACTOR_OF_SAFETY = 1.5
const FEE_RATE = 0.0025 *  FACTOR_OF_SAFETY
const MAX_LIQUIDITY_FRACTION = 0.2

const PUBLIC_KEY = 'dcec099969724a32befd7c64ec27c78b'
const SECRET_KEY = 'Nice try ;)'
const BASE_CURRENCIES = new Set(['BTC', 'ETH', 'USDT'])
const CURRENCY_VALUES = new Map([['USDT', 1]])
const EMITTER = new EventEmitter()

let PREVIOUS_TRADING_PAIRS = new Set()
let ORDERBOOK
let MARKET_SUMMARY
let MIN_ORDER_SIZES

let NUMBER_OF_TRADES = 0

EMITTER.on('main', main)
EMITTER.emit('main')


async function main() {
	try {
		cancelStaleOrders() // nonblocking
		const minOrderSizesPromise = getMinOrderSizes()
		const walletBalancesPromise = getWalletBalances() // nonblocking
		const marketSummaryPromise = getMarketSummary() // nonblocking
		ORDERBOOK = new OrderbookManager(PREVIOUS_TRADING_PAIRS) // nonblocking

		MIN_ORDER_SIZES = await minOrderSizesPromise
		const walletBalances = await walletBalancesPromise
		MARKET_SUMMARY = await marketSummaryPromise
		const actionPromises = walletBalances.map(computeTradeActions)
		logPortfolioValue(walletBalances)
		const tradeActions = await Promise.all(actionPromises)
		PREVIOUS_TRADING_PAIRS = ORDERBOOK.usedPairs
	} catch (error) {
		console.log(error)
	} finally {
		EMITTER.emit('main')
	}
}


function cancelStaleOrders() {
	makeAuthenticatedRequest('market/getopenorders', 'void=null').then(function(data) {
		const openOrders = JSON.parse(data).result
		const now = Date.now()
		for (var order of openOrders) {
			const elapsedTime = now - (new Date(order.Opened + 'Z')).getTime()
			console.log(elapsedTime)
			if (elapsedTime > ORDER_TIMEOUT_INTERVAL) {
				makeAuthenticatedRequest('market/cancel', 'uuid=' + order.OrderUuid).then(function (response) {
					console.log(JSON.parse(response).message)
				})
			}
		}
	})
}

function getMinOrderSizes() {
	const dataPromise = request('https://bittrex.com/api/v1.1/public/getmarkets')
	return dataPromise.then(function (data) {
		const exchanges = JSON.parse(data).result
		const minOrderSizes = new Map()
		for (var exchange of exchanges) minOrderSizes.set(exchange.MarketName, exchange.MinTradeSize)
		return minOrderSizes
	})
}

function getWalletBalances() {
	const balanceRequest = makeAuthenticatedRequest('account/getbalances', 'void=null')
	const processedBalancesPromise = balanceRequest.then(function (data) {
		const balances = new Array()
		const jsonBalances = JSON.parse(data).result
		for (var balance of jsonBalances) {
			if (balance.Available > 0) balances.push({
				'currency': balance.Currency,
				'balance': balance.Available
			})
		}
		return balances
	})
	return processedBalancesPromise
}

function getMarketSummary() {
	const dataPromise = request('https://bittrex.com/api/v1.1/public/getmarketsummaries')
	const summaryPromise = dataPromise.then(function (data) {
		const jsonData = JSON.parse(data).result
		const exchangeRates = new Map()
		for (var exchange of jsonData) {
			const currencies = exchange.MarketName.split('-')
			const baseCurrency = currencies[0]
			const marketCurrency = currencies[1]
			if (baseCurrency == 'USDT' && BASE_CURRENCIES.has(marketCurrency)) {
				CURRENCY_VALUES.set(marketCurrency, 0.5 * (exchange.Bid + exchange.Ask))
			}
			if (!exchangeRates.has(baseCurrency)) exchangeRates.set(baseCurrency, new Array())
			if (!exchangeRates.has(marketCurrency)) exchangeRates.set(marketCurrency, new Array())
			exchangeRates.set(exchange.MarketName, ({
				'bid': exchange.Bid,
				'ask': exchange.Ask
			}))
			if (exchange.Bid > 0) exchangeRates.get(marketCurrency).push({ // sell to convert to base currency
				'price': exchange.Bid,
				'buy': false,
				'convertsTo': baseCurrency,
				'exchange': exchange.MarketName
			})
			if (exchange.Ask > 0) exchangeRates.get(baseCurrency).push({ // buy to convert to market currency
				'price': 1 / exchange.Ask,
				'buy': true,
				'convertsTo': marketCurrency,
				'exchange': exchange.MarketName
			})
		}
		return exchangeRates
	})
	return summaryPromise
}

function OrderbookManager(initialTradingPairs) {
	this.usedPairs = new Set()
	this.orderbookData = new Map()
	this.orderbook = new Map()
	for (var tradingPair of initialTradingPairs) {
		const dataPromise = request('https://bittrex.com/api/v1.1/public/getorderbook?market=' + tradingPair + '&type=both')
		this.orderbookData.set(tradingPair, dataPromise)
	}
}

// nonblocking
OrderbookManager.prototype.getTradingPair = function (tradingPair) {
	if (!this.orderbook.has(tradingPair)) {
		this.usedPairs.add(tradingPair)
		if (this.orderbookData.has(tradingPair)) {
			const dataPromise = this.orderbookData.get(tradingPair)
			const orderbookPromise = dataPromise.then(function (data) {
				const result = JSON.parse(data).result
				if (result.buy === null) result.buy = []
				if (result.sell === null) result.sell = []
				return result
			})
			this.orderbook.set(tradingPair, orderbookPromise)
		} else {
			return null
			//dataPromise = request('https://bittrex.com/api/v1.1/public/getorderbook?market=' + tradingPair + '&type=both')
		}
	}
	return this.orderbook.get(tradingPair)
}


async function computeTradeActions(balance) {
	// returns a promise since the whole order book may not have loaded yet
	// just await the results of the orderbook
	try {
		const isBaseCurrency = BASE_CURRENCIES.has(balance.currency)
		const tradingPaths = getTradingPaths(balance.currency, isBaseCurrency)
		const trades = await calculateTradeAmounts(tradingPaths, balance, isBaseCurrency)
		const tradePromises = trades.map(function (trade) {
			let method
			let rates = MARKET_SUMMARY.get(trade.market)
			let rate
			if (trade.buy) {
				console.log('BUYING')
				method = 'market/buylimit'
				rate = rates.ask
			} else {
				console.log('SELLING')
				method = 'market/selllimit'
				rate = rates.bid
			}
			const queryString = '&market=' + trade.market + '&quantity=' + trade.amount + '&rate=' + rate
			console.log(queryString)
			NUMBER_OF_TRADES += 0.5
			return makeAuthenticatedRequest(method, queryString).then(function (response) {
				const json = JSON.parse(response)
				if (!json.success) {
					console.log('\n\n\nERROR ERROR ERROR ERROR ERROR ERROR ERROR ERROR')
					console.log(json.message)
					console.log('ERROR ERROR ERROR ERROR ERROR ERROR ERROR ERROR')
				}
			})
		})
		return await Promise.all(tradePromises)
	} catch (error) {
		console.log(error)
		return []
	}
}



function getTradingPaths(initialCurrency, isBaseCurrency) {
	const tradingPaths = new Array()
	let initialCurrencyValue
	if (isBaseCurrency) initialCurrencyValue = CURRENCY_VALUES.get(initialCurrency)
	for (var firstTrade of MARKET_SUMMARY.get(initialCurrency)) {
		const firstReturn = firstTrade.price * (1 - FEE_RATE)
		for (var secondTrade of MARKET_SUMMARY.get(firstTrade.convertsTo)) {
			const secondReturn = firstReturn * secondTrade.price * (1 - FEE_RATE)
			let notProfitable = true
			if (isBaseCurrency && BASE_CURRENCIES.has(secondTrade.convertsTo)) {
				// compute tether value
				const finalCurrencyValue = CURRENCY_VALUES.get(secondTrade.convertsTo)
				const profit = secondReturn * finalCurrencyValue / initialCurrencyValue
				notProfitable = profit < 0.998
				if (!notProfitable) tradingPaths.push({
					'profitability': profit,
					'tradePath': [firstTrade, secondTrade],
				})
			}
			if (notProfitable) {
				// compute cycle value
				for (var thirdTrade of MARKET_SUMMARY.get(secondTrade.convertsTo)) {
					if (thirdTrade.convertsTo == initialCurrency) {
						const profit = secondReturn * thirdTrade.price * (1 - FEE_RATE)
						if (!isBaseCurrency || profit > 0.998) tradingPaths.push({
							'profitability': profit,
							'tradePath': [firstTrade, secondTrade, thirdTrade]
						})
						break
					}
				}
			}
		}
	}

	console.log('\n\n\n\n')
	for (var tradePath of tradingPaths) console.log(initialCurrency + '-' + tradePath.tradePath.map(trade => trade.convertsTo).join('-') + ' ' + tradePath.profitability)
	return tradingPaths
}


async function calculateTradeAmounts(tradingPaths, balanceObject, ensureProfits) {
	for (var path of tradingPaths) {
		path['prefetchSuccess'] = true
		for (var exchange of path.tradePath) {
			if (!exchange.minOrderSize) {
				exchange['minOrderSize'] = getMinOrderSize(exchange)
				exchange['orderbook'] = await ORDERBOOK.getTradingPair(exchange.exchange)
			}
			path.prefetchSuccess = path.prefetchSuccess && (exchange.orderbook != null)
		}
	}
	const availableTradePaths = tradingPaths.filter(function (path) {
		try {		
			if (path.prefetchSuccess && (!ensureProfits || path.profitability > 1)) {
				const tradeInfo = bisectToMinOrder(path.tradePath, balanceObject)
				path['minOrderSize'] = tradeInfo.desiredAmountToTrade * 1.1
				path['maxActualProfitability'] = tradeInfo.returnOnTrade
				return (path.minOrderSize > path.tradePath[0].minOrderSize) && (!ensureProfits || tradeInfo.returnOnTrade > 1)
			}
		} catch (error) {
			console.log(error)
		}
		return false
	}).sort((left, right) => left.maxActualProfitability - right.maxActualProfitability) // sorted in ascending order


	let trades = new Array()	
	while (availableTradePaths.length > 0 && balanceObject.balance > 0) {
		const tradePath = availableTradePaths.pop()
		let tradeAmount = 0
		let tradeStats
		try {
			if (ensureProfits) {
				tradeStats =  bisectToMaxProfitability(tradePath.tradePath, balanceObject, tradePath.minOrderSize)
				console.log('Return: ' + tradeStats.returnOnTrade)
				tradeAmount = tradeStats.desiredAmountToTrade
				tradeAmount = Math.max(tradeAmount * MAX_LIQUIDITY_FRACTION, tradePath.minOrderSize)
				//console.log(tradeStats)
				tradeAmount = Math.min(balanceObject.balance, tradeAmount)
			} else {
				tradeAmount = tradeMaxAmount(tradePath.tradePath, balanceObject)
			}
		} catch (error) {
			console.log(error)
		}
		if (ensureProfits && (tradeAmount < tradePath.minOrderSize || tradeStats.returnOnTrade < 1)) continue
		balanceObject.balance -= tradeAmount
		const market = tradePath.tradePath[0]
		if (market.buy) tradeAmount *= tradeStats.tradeSizes[1] / tradeStats.tradeSizes[0] // convert to market currency
		trades.push({
			'market': market.exchange,
			'amount': tradeAmount,
			'buy': market.buy
		})
	}
	return trades
}

function getMinOrderSize(exchange) {
	let minQuantity = MIN_ORDER_SIZES.get(exchange.exchange)
	minQuantity = (exchange.buy) ? (minQuantity / exchange.price) : minQuantity	

	let minValue
	if (exchange.convertsTo != 'BTC') {
		const exchangeRates = MARKET_SUMMARY.get(exchange.convertsTo)
		let index = 0
		while (exchangeRates[index].convertsTo != 'BTC') index++
		minValue = MIN_BTC_TRADE_VALUE / exchangeRates[index].price
	} else {
		minValue = MIN_BTC_TRADE_VALUE
	}
	minValue /= exchange.price


	return Math.max(minQuantity, minValue)
}

function tradeMaxAmount(tradePath, balance) {
	let amountTraded = 0
	let bookIndex = 0
	if (tradePath[0].buying) {
		const orderbook = tradePath[0].orderbook.sell
		while (bookIndex < orderbook.length && amountTraded < balance.balance) {
			const order = orderbook[bookIndex]
			amountTraded += order.Quantity * order.Rate * (1 + FEE_RATE)
			bookIndex++
		}
	} else {
		const orderbook = tradePath[0].orderbook.buy
		while (bookIndex < orderbook.length && amountTraded < balance.balance) {
			amountTraded += orderbook[bookIndex].Quantity * (1 + FEE_RATE)
			bookIndex++
		}
	}
	return Math.min(amountTraded, balance.balance)
}

function tradeAmount(tradePath, amount, startingCurrency) {
	const tradeStats = {
		'desiredAmountToTrade': amount,
		'returnOnTrade': -1,
		'tradeSizes': new Array(tradePath.length),
		'sufficientLiquidity': false
	}
	let balanceRemaining = amount // current wallet balance
	let currencyObtained = 0//trade.amountTraded//amount already obtained from previous parities
	for (let i = 0; i < tradePath.length; i++) {
		const trade = tradePath[i]
		const tradeSize = balanceRemaining
		let orderbookIndex = 0
		let order
		if (trade.buy) {
			const orderbook = trade.orderbook.sell
			while (orderbookIndex < orderbook.length && balanceRemaining > 0) {
				order = orderbook[orderbookIndex]
				balanceRemaining -= order.Quantity * order.Rate * (1 + FEE_RATE)
				currencyObtained += order.Quantity
				orderbookIndex++
			}
			if (balanceRemaining < 0) {
				console.log(balanceRemaining)
				currencyObtained -= order.Quantity * (-balanceRemaining / (order.Quantity * order.Rate * (1 + FEE_RATE)))
				balanceRemaining = 0
			}
		} else {
			const orderbook = trade.orderbook.buy
			while(orderbookIndex < orderbook.length && balanceRemaining > 0) {
				order = orderbook[orderbookIndex]
				balanceRemaining -= order.Quantity * (1 + FEE_RATE)
				currencyObtained += order.Quantity * order.Rate
				orderbookIndex++
			}
			if (balanceRemaining < 0) {
				currencyObtained -= order.Quantity * order.Rate * (-balanceRemaining / (order.Quantity * (1 + FEE_RATE)))
				balanceRemaining = 0
			}
		}
		if (balanceRemaining > 0) return tradeStats // insufficient liquidity
		
		balanceRemaining = currencyObtained
		currencyObtained = 0
		tradeStats.tradeSizes[i] = tradeSize
	}
	if (tradePath.length == 2) {
		const originalValue = amount * CURRENCY_VALUES.get(startingCurrency)
		const finalValue = balanceRemaining * CURRENCY_VALUES.get(tradePath[1].convertsTo)
		tradeStats.returnOnTrade = finalValue / originalValue
	} else {
		tradeStats.returnOnTrade = balanceRemaining / amount
	}
	tradeStats.sufficientLiquidity = true
	return tradeStats
}

function bisectToMinOrder(tradePath, balance) {
	let tradeSize = balance.balance
	let increment = balance.balance / 2
	let smaller = true
	let tradeStats
	while (increment > 0.00002 * tradeSize) {
		tradeSize += (smaller) ? -increment : increment
		increment /= 2
		tradeStats = tradeAmount(tradePath, tradeSize, balance.currency)
		let tradeIndex = 0
		smaller = true
		if (tradeStats.sufficientLiquidity) {
			while (tradeIndex < tradeStats.tradeSizes.length && smaller) {
				smaller = tradeStats.tradeSizes[tradeIndex] > tradePath[tradeIndex].minOrderSize
				tradeIndex++
			}
		}
	}
	return tradeStats
}

function bisectToMaxProfitability(tradePath, balance, minOrder) {
	const fundsRemaining = balance.balance * 1.1 / MAX_LIQUIDITY_FRACTION
	let increment = (fundsRemaining - minOrder) / 2
	
	let centerAmount = minOrder + increment
	let center = tradeAmount(tradePath, centerAmount, balance.currency)
	let centerAbsoluteProfit = (center.returnOnTrade - 1) * center.desiredAmountToTrade

	while (increment > 0.00002 * centerAmount) {

		increment *= 0.5
		const leftCandidateAmount = centerAmount - increment
		const leftCandidate = tradeAmount(tradePath, leftCandidateAmount, balance.currency)
		const leftAbsoluteProfit = (leftCandidate.returnOnTrade - 1) * leftCandidateAmount
		if (leftAbsoluteProfit > centerAbsoluteProfit || !center.sufficientLiquidity) {
			centerAbsoluteProfit = leftAbsoluteProfit
			centerAmount = leftCandidateAmount
			center = leftCandidate
		} else {
			const rightCandidateAmount = centerAmount + increment
			const rightCandidate = tradeAmount(tradePath, rightCandidateAmount, balance.currency)
			const rightAbsoluteProfit = (rightCandidate.returnOnTrade - 1) * rightCandidateAmount
			if (rightAbsoluteProfit > centerAmount) {
				centerAbsoluteProfit = rightAbsoluteProfit
				centerAmount = rightCandidateAmount
				center = rightCandidate
			}
			//implicitly keep the same center and search closer if both were less than center
		}
	}
	return center
}

function logPortfolioValue(balances) {
	const btcValue = getConversionRate('BTC', 'USDT')
	let value = 0
	for (let balance of balances) {
		let conversionRate
		if (balance.currency != 'BTC') {
			conversionRate = getConversionRate(balance.currency, 'BTC')
		} else {
			conversionRate = 1
		}
		value += balance.balance * conversionRate
	}
	const dollarValue = value * btcValue
	console.log('Current portfolio value: ' + value + 'BTC     $' + dollarValue)
	console.log('Trades completed: ' + NUMBER_OF_TRADES)
}

function getConversionRate(currency, targetCurrency) {
	for (let exchangeRate of MARKET_SUMMARY.get(currency)) {
		if (exchangeRate.convertsTo == targetCurrency) return exchangeRate.price
	}
}

function makeAuthenticatedRequest(method, parameterString) {
	const nonce = Date.now()
	const url = 'https://bittrex.com/api/v1.1/' + method + '?apikey=' + PUBLIC_KEY + '&nonce=' + nonce + '&' + parameterString
	const sha512 = Crypto.createHmac('sha512', SECRET_KEY)
	sha512.update(url)
	const hash = sha512.digest('hex')
	return request({
		'url': url,
		'headers': {
			'apisign': hash
		}
	})
}



