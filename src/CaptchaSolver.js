const Rembrandt = require('rembrandt')
const Jimp = require('jimp')

class CaptchaSolver {
  page
  options
  startImage

  constructor(page) {
    this.page = page

    const responseHandler = this._responseHandler()
    this.page.on(
      'response',
      async (response) => await responseHandler(response)
    )
  }

  get defaults() {
    return {
      numAttempts: 3,
      startPosition: 25,
      positionIncrement: 5,
    }
  }

  get selectors() {
    return {
      verifyElement: '[id$="verify-ele"], #login_slide',
      verifyContainer: '.captcha_verify_container',

      puzzleImageWrapper: '.captcha_verify_img--wrapper',
      puzzleImage: '#captcha-verify-image',
      puzzlePiece: '.captcha_verify_img_slide',
      sliderElement: '.captcha_verify_slide--slidebar',
      sliderHandle: '.secsdk-captcha-drag-icon',

      puzzlePieceOverlay: '#captcha_overlay_box',
    }
  }

  async solve(options) {
    return this._watchForCaptchaAdd().then(
      () => this.solveUntil(options),
      () => {
        /* ignore */
      }
    )
  }

  async solveUntil(options) {
    this.options = Object.assign(this.defaults, options)

    let isNotSolved = true

    do {
      isNotSolved = await this._solveCaptcha()
    } while (isNotSolved && --this.options.numAttempts > 0)

    return isNotSolved
      ? Promise.reject(new Error(`Exceeded captcha solve attempts`))
      : Promise.resolve()
  }

  async _solveCaptcha() {
    await this.page.evaluate(
      this._appendOverlayAndHidePuzzlePiece,
      this.selectors
    )

    const sliderElement = await this.page.$(this.selectors.sliderElement)
    const sliderHandle = await this.page.$(this.selectors.sliderHandle)
    const slider = await sliderElement.boundingBox()
    const handle = await sliderHandle.boundingBox()

    let currentPosition = this.options.startPosition

    const target = {
      position: 0,
      difference: 100,
    }

    await this.page.waitForTimeout(3000)
    await this.page.mouse.move(
      handle.x + handle.width / 2,
      handle.y + handle.height / 2
    )
    await this.page.mouse.down()

    while (currentPosition < slider.width - handle.width / 2) {
      await this.page.mouse.move(
        handle.x + currentPosition,
        handle.y + handle.height / 2
      )

      await this.page.evaluate(
        this._syncOverlayPositionWithPuzzlePiece,
        this.selectors
      )

      const sliderContainer = await this.page.$(
        this.selectors.puzzleImageWrapper
      )
      const sliderImage = await sliderContainer.screenshot()
      const currentImage = await this._resizeImage(sliderImage)

      const rembrandt = new Rembrandt({
        imageA: this.startImage,
        imageB: currentImage,
        thresholdType: Rembrandt.THRESHOLD_PIXELS,
      })

      const result = await rembrandt.compare()
      const difference = result.percentageDifference * 100

      if (target.difference > difference) {
        target.difference = difference
        target.position = currentPosition
      }

      currentPosition += this.options.positionIncrement
    }

    await this.page.evaluate(
      this._removeOverlayAndShowPuzzlePiece,
      this.selectors
    )
    const isVerifyPage = await this._isVerifyPage()

    await this.page.mouse.move(
      handle.x + target.position,
      handle.y + handle.height / 2
    )
    await this.page.mouse.up()

    return this._waitForCaptchaDismiss(isVerifyPage)
  }

  async _isVerifyPage() {
    return (await this.page.title()) === 'tiktok-verify-page'
  }

  async _waitForCaptchaDismiss(isVerifyPage) {
    if (isVerifyPage) {
      try {
        await this.page.waitForNavigation({
          timeout: 5000,
          waitUntil: this.isPlaywright ? 'networkidle' : 'networkidle0',
        })
      } catch (e) {
        /* ignore */
      }

      return this._isVerifyPage()
    }

    try {
      return await this.page.evaluate(
        this._waitForCaptchaDomRemove,
        this.selectors
      )
    } catch (e) {
      return Promise.resolve(true)
    }
  }

  get captchaElements() {
    const {
      puzzleImageWrapper,
      puzzleImage,
      puzzlePiece,
      sliderElement,
      sliderHandle,
    } = this.selectors
    return [
      puzzleImageWrapper,
      puzzleImage,
      puzzlePiece,
      sliderElement,
      sliderHandle,
    ]
  }

  async _watchForCaptchaAdd() {
    try {
      await this.page.waitForSelector(this.selectors.verifyElement, {
        timeout: 5000,
      })
      await this.page.evaluate(this._waitForCaptchaDomAdd, this.selectors)
      const waitForCaptchaElements = this.captchaElements.map((el) =>
        this.page.waitForSelector(el, { state: 'attached' })
      )
      return await Promise.all(waitForCaptchaElements)
    } catch (e) {
      return Promise.reject(new Error('Failed to find verify element'))
    }
  }

  async _waitForCaptchaDomAdd({ verifyElement, verifyContainer }) {
    const target = document.querySelector(verifyElement)

    if (document.querySelector(verifyContainer)) return Promise.resolve()

    return new Promise((resolve, reject) => {
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.addedNodes.length) {
            for (const addedNode of mutation.addedNodes) {
              if (
                addedNode.classList &&
                addedNode.classList.contains(verifyContainer.slice(1))
              ) {
                observer.disconnect()
                resolve()
                break
              }
            }
          }
        }
      })

      observer.observe(target, { childList: true, subtree: true })
    })
  }

  async _waitForCaptchaDomRemove({ verifyElement, verifyContainer }) {
    return new Promise((resolve, reject) => {
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.removedNodes.length) {
            for (const removedNode of mutation.removedNodes) {
              if (
                removedNode.classList &&
                removedNode.classList.contains(verifyContainer.slice(1))
              ) {
                observer.disconnect()
                resolve()
                break
              }
            }
          }
        }
      })

      observer.observe(document.querySelector(verifyElement), {
        childList: true,
      })

      setTimeout(reject.bind(this), 5000)
    })
  }

  async _resizeImage(image) {
    const readResult = await Jimp.read(image)
    const resize = await readResult.resize(276, 172)
    return resize.getBufferAsync(Jimp.MIME_JPEG)
  }

  _syncOverlayPositionWithPuzzlePiece({ puzzlePiece, puzzlePieceOverlay }) {
    const puzzlePieceEl = document.querySelector(puzzlePiece)
    const overlayEl = document.querySelector(puzzlePieceOverlay)
    overlayEl.style.left = puzzlePieceEl.style.left
  }

  _removeOverlayAndShowPuzzlePiece({ puzzlePieceOverlay, puzzlePiece }) {
    document.querySelector(puzzlePieceOverlay).remove()
    document.querySelector(puzzlePiece).style.display = 'block'
  }

  validCaptchaUrl(url) {
    const matchesSecurityCaptchaUrl = url.includes('security-captcha')

    const captchaImageSubUrls = [
      'captcha-us.ibyteimg.com/',
      'captcha-va.ibyteimg.com/',
    ]

    const matchesByteImgUrls =
      captchaImageSubUrls.find((subUrl) => url.includes(subUrl)) &&
      url.includes('-2.jpeg')

    return matchesSecurityCaptchaUrl || matchesByteImgUrls
  }

  _responseHandler() {
    let maxContentLength = -1

    return async (response) => {
      const responseUrl = response.url()
      if (!this.validCaptchaUrl(responseUrl)) {
        return
      }

      const contentLength = Number(response.headers()['content-length'])

      if (contentLength > maxContentLength) {
        maxContentLength = contentLength
        this.startImage = await this._resizeImage(
          await (this.isPlaywright ? response.body() : response.buffer())
        )
      }
    }
  }

  _appendOverlayAndHidePuzzlePiece({
    puzzlePiece,
    puzzlePieceOverlay,
    puzzleImageWrapper,
  }) {
    const puzzlePieceEl = document.querySelector(puzzlePiece)
    const div = document.createElement('div')
    div.id = puzzlePieceOverlay.slice(1)

    const topPosition = Number(puzzlePieceEl.style.top.split('em')[0])
    Object.assign(div.style, {
      position: 'absolute',
      top: `${topPosition + 0.05}em`,
      left: puzzlePieceEl.style.left,
      width: '0.617536em',
      height: '0.617536em',
      backgroundColor: 'magenta',
    })

    puzzlePieceEl.style.display = 'none'
    document.querySelector(puzzleImageWrapper).appendChild(div)
  }

  get isPlaywright() {
    return this.page.hasOwnProperty('_guid')
  }
}

module.exports = CaptchaSolver
