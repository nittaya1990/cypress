import _ from 'lodash'
import $ from 'jquery'

import $Location from '../../cypress/location'
import $errUtils, { errs, throwErrByPath } from '../../cypress/error_utils'
import $stackUtils from '../../cypress/stack_utils'

type LocalStorageData = {origin: string, value: object}
type LocalStorageOptions = {origin: string, value?: object, clear?: boolean}

const getSessionDetails = (sessState) => {
  return {
    name: sessState.name,
    data: _.merge(
      _.mapValues(_.groupBy(sessState.cookies, 'domain'), (v) => ({ cookies: v.length })),
      ..._.map(sessState.localStorage, (v) => ({ [$Location.create(v.origin).hostname]: { localStorage: Object.keys(v.value).length } })),
    ) }
}
const getSessionDetailsForTable = (sessState) => {
  return _.merge(
    _.mapValues(_.groupBy(sessState.cookies, 'domain'), (v) => ({ cookies: v })),
    ..._.map(sessState.localStorage, (v) => ({ [$Location.create(v.origin).hostname]: { localStorage: v } })),
  )
}

const getConsoleProps = (sessState) => {
  const ret = {
    name: sessState.name,
    table: _.compact(_.flatMap(getSessionDetailsForTable(sessState), (val, domain) => {
      return [() => {
        return {
          name: `🍪 Cookies - ${domain} (${val.cookies.length})`,
          data: val.cookies,
        }
      },
      val.localStorage && (() => {
        return {
          name: `📁 Storage - ${domain} (${_.keys(val.localStorage.value).length})`,
          data: _.map(val.localStorage.value, (value, key) => {
            return {
              key, value,
            }
          }),
        }
      })]
    }))
    ,
  }

  return ret
}

export default function (Commands, Cypress, cy) {
  const { Promise } = Cypress

  const setActiveSession = (obj) => {
    const currentSessions = cy.state('activeSessions') || {}

    const newSessions = { ...currentSessions, ...obj }

    cy.state('activeSessions', newSessions)
  }
  const getActiveSession = (name) => {
    const currentSessions = cy.state('activeSessions') || {}

    return currentSessions[name]
  }
  const clearActiveSessions = () => {
    const curSessions = cy.state('activeSessions') || {}

    cy.state('activeSessions', _.mapValues(curSessions, (v) => ({ ...v, hydrated: false })))
  }

  async function mapOrigins (origins) {
    const current_origin = $Location.create(window.location.href).origin

    return _.uniq(
      _.flatten(await Promise.map(
        ([] as string[]).concat(origins), async (v) => {
          if (v === '*') {
            return _.keys(await Cypress.backend('get:renderedHTMLOrigins')).concat([current_origin])
          }

          if (v === 'current_origin') return current_origin

          return $Location.create(v).origin
        },
      )),
    ) as string[]
  }

  async function _setLocalStorageOnOrigins (originOptions) {
    const specWindow = cy.state('specWindow')

    const current_origin = $Location.create(window.location.href).origin

    const current_origin_options_index = _.findIndex(originOptions, { origin: current_origin })

    if (current_origin_options_index !== -1) {
      const currentOriginOptions = originOptions.splice(current_origin_options_index, 1)[0]

      if (currentOriginOptions.clear) {
        window.localStorage.clear()
      }

      if (currentOriginOptions.value) {
        _.each(currentOriginOptions.value, (val, key) => localStorage.setItem(key, val))
      }
    }

    if (_.isEmpty(originOptions)) {
      return
    }

    const origins = originOptions.map((v) => v.origin) as string[]

    const iframes: JQuery<HTMLElement>[] = []

    const $iframeContainer = $(`<div style="display:none"></div>`).appendTo($('body', specWindow.document))

    // if we're on an https domain, there is no way for the secure context to access insecure origins from iframes
    // since there is no way for the app to access localStorage on insecure contexts, we don't have to clear any localStorage on http domains.
    if (current_origin.startsWith('https:')) {
      _.remove(origins, (v) => v.startsWith('http:'))
    }

    _.each(origins, (u) => {
      const $iframe = $(`<iframe src="${`${u}/__cypress/automation/setLocalStorage?${u}`}"></iframe>`)

      $iframe.appendTo($iframeContainer)
      iframes.push($iframe)
    })

    let onPostMessage

    const successOrigins = [] as string[]

    await new Promise((resolve) => {
      onPostMessage = (event) => {
        const data = event.data

        if (data.type === 'set:localStorage:load') {
          if (!event.source) {
            throw new Error('failed to get localStorage')
          }

          const opts = _.find(originOptions, { origin: event.origin })!

          event.source.postMessage({ type: 'set:localStorage:data', value: opts.value || {}, clear: opts.clear }, '*')
        } else if (data.type === 'set:localStorage:complete') {
          successOrigins.push(event.origin)
          if (successOrigins.length === origins.length) {
            resolve()
          }
        }
      }

      specWindow.addEventListener('message', onPostMessage)
    })
    .timeout(2000)
    .catch((err) => {
      Cypress.log({
        name: 'warning',
        message: `failed to set session data on origin(s): ${_.xor(origins, successOrigins).join(', ')}`,
      })
    })
    .finally(() => {
      specWindow.removeEventListener('message', onPostMessage)
      $iframeContainer.remove()
    })
  }

  async function getAllHtmlOrigins () {
    const current_origin = $Location.create(window.location.href).origin

    const origins = _.uniq([..._.keys(await Cypress.backend('get:renderedHTMLOrigins')), current_origin]) as string[]

    return origins
  }

  function throwIfNoSessionSupport () {
    if (!Cypress.config('experimentalSessionSupport')) {
      // TODO: proper error msg
      throw new Error('experimentalSessionSupport is not enabled. You must enable the experimentalSessionSupport flag in order to use Cypress session commands')
    }
  }

  interface defineSessionOpts {
    name: string
    steps: Function
    validate?: Function
    before?: Function
    after?: Function
  }

  const sessions = {

    defineSession (name: string | defineSessionOpts, stepsFn?: Function, options = {} as defineSessionOpts) {
      throwIfNoSessionSupport()

      if (_.isObject(name)) {
        options = name as defineSessionOpts
        name = options.name
        stepsFn = options.steps
      }

      if (!name) {
        $errUtils.throwErrByPath(errs.sessions.defineSession.missing_argument, { args: { name: 'name' } })
      }

      if (!stepsFn) {
        $errUtils.throwErrByPath(errs.sessions.defineSession.missing_argument, { args: { name: 'steps function' } })
      }

      const sess_state = {
        name,
        cookies: null,
        localStorage: null,
        steps: stepsFn,
        hydrated: false,
        after: options.after,
        before: options.before,
        validate: options.validate,
      }

      if (getActiveSession(sess_state.name)) {
        const invocationStack = $stackUtils.getInvocationDetails(cy.state('specWindow'), Cypress.config)?.stack

        throw $errUtils.errByPath(errs.sessions.defineSession.duplicateName, { name: sess_state.name })
        .setUserInvocationStack(invocationStack)
      }

      setActiveSession({ [sess_state.name]: sess_state })

      return sess_state
    },

    async clearAllSavedSessions () {
      clearActiveSessions()

      return Cypress.backend('clear:session', null)
    },

    async clearCurrentSessionData () {
      window.localStorage.clear()
      window.sessionStorage.clear()

      await Promise.all([
        sessions.clearLocalStorage(),
        sessions.clearCookies(),
      ])
    },

    async setSessionData (data) {
      window.localStorage.clear()
      window.sessionStorage.clear()
      const allHtmlOrigins = await getAllHtmlOrigins()
      const originsToClearOnly = _.filter(allHtmlOrigins, (origin) => !_.find(data.localStorage, { origin })).map((origin) => ({ origin, clear: true }))
      const originOptions = originsToClearOnly.concat(data.localStorage.map((v) => ({ ...v, clear: true })))

      await Promise.all([_setLocalStorageOnOrigins(originOptions), Cypress.automation('clear:cookies', null)])

      await sessions.setCookies(data.cookies)
    },

    getCookies () {
      return Cypress.automation('get:cookies', {})
    },

    setCookies (data) {
      return Cypress.automation('set:cookies', data)
    },

    async clearCookies () {
      return Cypress.automation('clear:cookies', await sessions.getCookies())
    },

    async getCurrentSessionData (options) {
      const opts = _.defaults(options, {
        exclude: false,
      })

      let exlcudeLS = _.get(opts.exclude, 'localStorage')
      let excludeCookies = _.get(opts.exclude, 'cookies')

      let LS = [] as LocalStorageData[]

      if (exlcudeLS !== true) {
        LS = await sessions.getLocalStorage({ origin: '*' })

        if (_.isString(exlcudeLS) || _.isObject(exlcudeLS)) {
          exlcudeLS = [].concat(exlcudeLS)
          _.each(exlcudeLS, (filter: {origin?: string|RegExp, key?: string|RegExp}) => {
            if (_.isString(filter) || _.isRegExp(filter)) {
              filter = { key: filter }
            }

            const matchOrigin = !filter.origin ?
              () => true :
              _.isRegExp(filter.origin) ?
                (target) => target.match(filter.origin)
                : (target) => target === filter.origin

            const matchValue = _.isRegExp(filter.key) ?
              (target) => target.match(filter.key)
              : (target) => filter.key === target

            LS = _.flatMap(LS, (target) => {
              if (matchOrigin(target.origin)) {
                // if there's no filter criteria, exclude everything
                if (!filter.key) return []

                target.value = _.cloneDeepWith(target.value, (value) => {
                  if (_.isObject(value)) {
                    return _.omitBy(value, (__, key) => matchValue(key))
                  }

                  // clone like normal
                  return
                })
              }

              if (_.isEmpty(target.value)) {
                return []
              }

              return [target]
            })
          })
        }
      }

      let cookies = [] as any[]

      if (excludeCookies !== true) {
        cookies = await Cypress.automation('get:cookies', {})

        if (_.isObjectLike(excludeCookies)) {
          excludeCookies = [].concat(excludeCookies)
          _.each(excludeCookies, (filter: {domain?: string | RegExp, name?: string | RegExp}) => {
            if (_.isString(filter) || _.isRegExp(filter)) {
              filter = { name: filter }
            }

            const matchDomain = !filter.domain ? true : _.isRegExp(filter.domain) ? (target) => target.match(filter.domain) : (target) => target === filter.domain
            const matchName = !filter.name ? true : _.isRegExp(filter.name) ? (target) => target.match(filter.name) : (target) => target === filter.name

            cookies = _.flatMap(cookies, (target) => {
              if (matchDomain === true || matchDomain(target.domain)) {
                if (matchName === true || matchName(target.name)) return []
              }

              return [target]
            })
          })
        }
      }

      const ses = {
        localStorage: LS,
        cookies,
      }

      return ses
    },

    getSession (name) {
      return Cypress.backend('get:session', name)
    },

    async saveSession (name: string, options) {
      const ses = await sessions.getCurrentSessionData({
        exclude: options.exclude,
      })

      return Cypress.backend('save:session', { ...ses, name })
    },

    /**
     * 1) if we only need current_origin localStorage, access sync
     * 2) if cross-origin http, we need to load in iframe from our proxy that will intercept all http reqs at /__cypress/automation/*
     *      and postMessage() the localStorage value to us
     * 3) if cross-origin https, since we pass-thru https conntections in the proxy, we need to
     *      send a message telling our proxy server to intercept the next req to the https domain,
     *      then follow 2)
     */
    async getLocalStorage (options = {}) {
      const specWindow = cy.state('specWindow')

      if (!_.isObject(options)) {
        throw new Error('getLocalStorage() takes an object')
      }

      const opts = _.defaults({}, options, {
        origin: 'current_origin',
      })

      const current_origin = $Location.create(window.location.href).origin

      const origins = await mapOrigins(opts.origin)

      const results = [] as LocalStorageData[]

      const currentOriginIndex = origins.indexOf(current_origin)

      if (currentOriginIndex !== -1) {
        origins.splice(currentOriginIndex, 1)
        const value = JSON.parse(JSON.stringify(window.localStorage))

        if (!_.isEmpty(value)) {
          results.push({ origin: current_origin, value })
        }
      }

      if (_.isEmpty(origins)) {
        return results
      }

      if (current_origin.startsWith('https:')) {
        _.remove(origins, (v) => v.startsWith('http:'))
      }

      const iframes: JQuery<HTMLElement>[] = []

      const $iframeContainer = $(`<div style="display:none"></div>`).appendTo($('body', specWindow.document))

      _.each(origins, (u) => {
        const $iframe = $(`<iframe src="${`${u}/__cypress/automation/getLocalStorage`}"></iframe>`)

        $iframe.appendTo($iframeContainer)
        iframes.push($iframe)
      })

      let onPostMessage
      const successOrigins = [] as string[]

      const crossOriginResults: LocalStorageData[] = []

      await new Promise((resolve) => {
        onPostMessage = ((event) => {
          const data = event.data

          if (data.type !== 'localStorage') return

          const value = JSON.parse(data.value)

          successOrigins.push(event.origin)

          if (!_.isEmpty(value)) {
            crossOriginResults.push({ origin: event.origin, value })
          }

          if (successOrigins.length === origins.length) {
            resolve()
          }
        })

        specWindow.addEventListener('message', onPostMessage)
      })
      .catch((err) => {
        Cypress.log({
          name: 'warning',
          message: `failed to set session data on origin(s): ${_.xor(origins, successOrigins).join(', ')}`,
        })
      })
      .finally(() => {
        specWindow.removeEventListener('message', onPostMessage)
        $iframeContainer.remove()
      })

      return [...results, ...crossOriginResults]
    },

    async clearLocalStorage () {
      const origins = await getAllHtmlOrigins()

      const originOptions = origins.map((v) => ({ origin: v, clear: true }))

      await sessions.setLocalStorage(originOptions)
    },

    async setLocalStorage (options: LocalStorageOptions[]) {
      const current_origin = $Location.create(window.location.href).origin as string

      const originOptions = _.chain([] as LocalStorageOptions[])
      .concat(options)
      .map((v) => ({ ...v, origin: v.origin && v.origin !== 'current_origin' ? $Location.create(v.origin).origin : current_origin }))
      .value() as LocalStorageOptions[]

      await _setLocalStorageOnOrigins(originOptions)
    },

    registerSessionHooks () {
      Cypress.on('test:before:run:async', () => {
        Cypress.action('cy:url:changed', '')

        return Cypress.action('cy:visit:blank')
        .then(() => {
          return sessions.clearCurrentSessionData()
        }).then(() => {
          return Cypress.backend('reset:renderedHTMLOrigins')
        })
      })
    },

  }

  if (Cypress.config('experimentalSessionSupport')) {
    sessions.registerSessionHooks()
  }

  Commands.addAll({
    session (name, stepsFn?: Function, options: {
      validate?: Function
    } = {}) {
      throwIfNoSessionSupport()

      if (!name || !_.isString(name)) {
        throw new Error('cy.session requires a string as the first argument')
      }

      if (options) {
        if (!_.isObject(options)) {
          throw new Error('cy.session optional third argument must be an object')
        }

        const validopts = {
          'validate': 'function',
          'exclude': 'object',
        }

        Object.keys(options).forEach((key) => {
          const expectedType = validopts[key]

          if (!expectedType) {
            throw new Error(`unexpected option **${key}** passed to cy.session options`)
          }

          const actualType = typeof options[key]

          if (actualType !== expectedType) {
            throw new Error(`invalid option **${key}** passed to cy.session options. Expected **${expectedType}**, got ${actualType}`)
          }
        })
      }

      let existingSession = getActiveSession(name)

      if (existingSession) {
        if (stepsFn) {
          if (existingSession.steps.toString().trim() !== stepsFn.toString().trim()) {
            throw $errUtils.errByPath(errs.sessions.session.duplicateName, { name: existingSession.name })
          }
        }
      }

      if (!existingSession) {
        if (!stepsFn) {
          throwErrByPath(errs.sessions.session.not_found, { args: { name } })
        }

        existingSession = sessions.defineSession({
          name,
          steps: stepsFn,
          validate: options.validate,
        })
      }

      const wrap = (obj) => {
        // await a returned chainer OR promises
        if (Cypress.isCy(obj)) {
          return obj
        }

        return cy.wrap(obj, { log: false })
      }

      const _log = Cypress.log({
        name: 'session',
        sessionInfo: getSessionDetails(existingSession),
        message: `**${existingSession.name}**`,
        type: 'parent',
        state: 'passed',
      })

      const initialize = async () => {
        if (existingSession.hydrated) return existingSession

        const serverStoredSession = await sessions.getSession(existingSession.name).catch(_.noop)

        if (serverStoredSession && serverStoredSession.steps === existingSession.steps.toString()) {
          existingSession.localStorage = serverStoredSession.localStorage
          existingSession.cookies = serverStoredSession.cookies
          existingSession.hydrated = true
        }
      }

      // return wrap(initialize(), { log: false })
      wrap(initialize())
      cy.then(async () => {
        Cypress.log({
          groupStart: true,
        })

        if (!existingSession.hydrated) {
          return false
        }

        if (existingSession.validate) {
          return wrap(existingSession.validate())
        }

        return true
      })
      .then(async (isValid) => {
        if (isValid === false) {
          return false
        }

        _log.set({
          message: 'using saved session',
          // consoleProps: { table: [() => ({ name: 'foo', data: [{ foo: true, bar: true }] })] },
          // consoleProps: () => getConsoleProps(sess_state),

          // state: 'passed',
        })

        if (existingSession.before) {
          wrap(existingSession.before())
        }

        await sessions.setSessionData(existingSession)

        return wrap(true)
      })

      .then(async (alreadyHydrated) => {
        if (alreadyHydrated) return

        // _log.set({
        //   message: sess_state.hydrated ? 'session invalidated, using new session' : 'using new session',
        // })

        // Cypress.log({
        //   name: 'session',
        //   message: `**${sess_state.name}** - using new session`,
        //   type: 'parent',
        //   sessionInfo: { name: sess_state.name },
        //   state: 'pending',
        //   consoleProps: () => getConsoleProps(sess_state),
        // })

        if (existingSession.before) {
          wrap(existingSession.before())
        }

        cy.then(() => sessions.clearCurrentSessionData())

        .then(() => existingSession.steps())

        .then(() => {
          wrap(sessions.getCurrentSessionData({
            exclude: options.exclude,
          }).then((data) => {
            existingSession.cookies = data.cookies
            existingSession.localStorage = data.localStorage
            existingSession.hydrated = true

            setActiveSession({ [existingSession.name]: existingSession })

            const sessionDetails = getSessionDetails(existingSession)

            Cypress.log({
              name: 'Session',
              state: 'passed',
              sessionInfo: sessionDetails,
              message: `Finished registering session`,
              emitOnly: true,
            })

            _log.set({

              consoleProps: () => getConsoleProps(existingSession),
              // consoleProps () {
              //   return {
              //     'table': [() => {
              //       return {
              //         name: 'ents',
              //         data: [{ foo: true }],
              //       }
              //     }],
              //   }
              // },
            })

            // persist the session to the server, it can happen async/dangling since this doesn't affect the test
            // and really only matters in openMode and if there's a top navigation on a future test.
            // eslint-disable-next-line no-console
            void Cypress.backend('save:session', { ...existingSession }).catch(console.error)
          }))
        })
      })
      .then(() => {
        Cypress.action('cy:url:changed', '')

        return Cypress.action('cy:visit:blank', { type: 'session' })
      })

      .then(() => {
        Cypress.log({ groupEnd: true })

        return {
          localStorage: existingSession.localStorage,
          cookies: existingSession.cookies,
        }
      })
    },
  })

  // cy.defineSession = sessions.defineSession

  Cypress.session = sessions
}
