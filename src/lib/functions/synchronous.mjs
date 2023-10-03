// @ts-check
import { Buffer } from 'buffer'

import { isStream } from 'is-stream'

import { chalk, log, NETLIFYDEVERR } from '../../utils/command-helpers.mjs'
import renderErrorTemplate from '../render-error-template.mjs'

import { detectAwsSdkError } from './utils.mjs'

/**
 * @typedef LambdaLocalError
 * @property {string} errorType
 * @property {string} errorMessage
 * @property {Array<string>} stackTrace
 */

/**
 * @typedef InvocationError
 * @property {string} errorType
 * @property {string} errorMessage
 * @property {string} stackTrace
 */

const addHeaders = (headers, response) => {
  if (!headers) {
    return
  }

  Object.entries(headers).forEach(([key, value]) => {
    response.setHeader(key, value)
  })
}

export const handleSynchronousFunction = function ({
  error: invocationError,
  functionName,
  request,
  response,
  result,
}) {
  if (invocationError) {
    const error = getNormalizedError(invocationError)

    log(
      `${NETLIFYDEVERR} Function ${chalk.yellow(functionName)} has returned an error: ${
        error.errorMessage
      }\n${chalk.dim(error.stackTrace)}`,
    )

    return handleErr(invocationError, request, response)
  }

  const { error } = validateLambdaResponse(result)
  if (error) {
    log(`${NETLIFYDEVERR} ${error}`)
    return handleErr(error, request, response)
  }

  response.statusCode = result.statusCode

  try {
    addHeaders(result.headers, response)
    addHeaders(result.multiValueHeaders, response)
  } catch (headersError) {
    const normalizedError = getNormalizedError(headersError)

    log(
      `${NETLIFYDEVERR} Failed to set header in function ${chalk.yellow(functionName)}: ${
        normalizedError.errorMessage
      }`,
    )

    return handleErr(headersError, request, response)
  }

  if (result.body) {
    if (isStream(result.body)) {
      result.body.pipe(response)

      return
    }

    response.write(result.isBase64Encoded ? Buffer.from(result.body, 'base64') : result.body)
  }
  response.end()
}

/**
 * Accepts an error generated by `lambda-local` or an instance of `Error` and
 * returns a normalized error that we can treat in the same way.
 *
 * @param {LambdaLocalError|Error} error
 * @returns {InvocationError}
 */
const getNormalizedError = (error) => {
  if (error instanceof Error) {
    return {
      errorMessage: error.message,
      errorType: error.name,
      stackTrace: error.stack ?? '',
    }
  }

  const stackTrace = error.stackTrace.map((line) => `    at ${line}`).join('\n')

  return {
    errorType: error.errorType,
    errorMessage: error.errorMessage,
    stackTrace,
  }
}

const formatLambdaLocalError = (rawError, acceptsHTML) => {
  const error = getNormalizedError(rawError)

  if (acceptsHTML) {
    return JSON.stringify({
      ...error,
      stackTrace: undefined,
      trace: error.stackTrace.split('\n'),
    })
  }

  return `${error.errorType}: ${error.errorMessage}\n ${error.stackTrace}`
}

const handleErr = async (err, request, response) => {
  detectAwsSdkError({ err })

  const acceptsHtml = request.headers && request.headers.accept && request.headers.accept.includes('text/html')
  const errorString = typeof err === 'string' ? err : formatLambdaLocalError(err, acceptsHtml)

  response.statusCode = 500

  if (acceptsHtml) {
    response.setHeader('Content-Type', 'text/html')
    response.end(await renderErrorTemplate(errorString, './templates/function-error.html', 'function'))
  } else {
    response.end(errorString)
  }
}

const validateLambdaResponse = (lambdaResponse) => {
  if (lambdaResponse === undefined) {
    return { error: 'lambda response was undefined. check your function code again' }
  }
  if (lambdaResponse === null) {
    return {
      error: 'no lambda response. check your function code again. make sure to return a promise or use the callback.',
    }
  }
  if (!Number(lambdaResponse.statusCode)) {
    return {
      error: `Your function response must have a numerical statusCode. You gave: ${lambdaResponse.statusCode}`,
    }
  }
  if (lambdaResponse.body && typeof lambdaResponse.body !== 'string' && !isStream(lambdaResponse.body)) {
    return { error: `Your function response must have a string or a stream body. You gave: ${lambdaResponse.body}` }
  }

  return {}
}
