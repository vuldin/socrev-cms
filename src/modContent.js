const Turndown = require('turndown')
const ytRegex = require('youtube-regex')
const vmRegex = require('vimeo-regex')
//const emailRegex = require('email-regex')
const marked = require('marked')

const modLinks = require('./modLinks')
const handleRefLinks = require('./handleRefLinks')

const turndown = new Turndown({ linkStyle: 'referenced' })

module.exports = async (oldContent, wp) => {
  // handle videos
  // look for iframes, pull link, replace iframe with something that is not ignored by turndown
  const iframeRe = /(\<iframe ).+? src="(.+?(?=")).+?(<\/iframe>)/g
  let iframeMatches = []
  let iframeReplaces = []
  let iframeMatch
  while ((iframeMatch = iframeRe.exec(oldContent))) {
    iframeMatches.push(iframeMatch[2])
    iframeReplaces.push(iframeMatch[0])
  }
  iframeMatches.forEach((m, i) => {
    oldContent = oldContent.replace(
      iframeReplaces[i],
      `IFRAME-START${iframeMatches[i]}IFRAME-END`
    )
  })

  const markdown = turndown.turndown(oldContent) // html to markdown
  const mds = markdown.split('\n\n')
  let content = [] // future modified post content

  // determine if there are links, modify if they exist
  // there is a bug with lex that causes it to stop picking up links after 27
  // so we'll use lex only to determine if there are links
  let newLinks = {}
  const lex = marked.lexer(markdown)
  let haveLinks = false
  if (Object.keys(lex.links).length > 0) {
    // we have links
    haveLinks = true
    newLinks = await modLinks(mds[mds.length - 1], wp)
  }

  mds.forEach((d, i) => {
    // the following statement ensures we don't process the last links entry
    if (haveLinks && i === mds.length - 1) return

    let key = 'content'
    /* content entries can be the following types:
     * - content: default
     * - heading
     * - img
     * - youtube
     * - vimeo
     * - center: short content, could be multi-line, must be centered
     * - caption: also short and centered, but should also be combined with associated image
    */

    // header
    if (d[0] === '#') key = 'heading'

    // img handling
    // each image is separated into its own entry in the content of a post
    const mdImgReg = /\!\[(.*?)\]\(.*?\)/g // matches ![](https://link/img.jpg)
    const imgs = d.match(mdImgReg) // array of imgs in this entry
    if (Array.isArray(imgs)) {
      // entry contains images
      let texts = [] // array of texts for this entry
      d.split(mdImgReg).forEach(t => {
        // grab the rest of the text from a paragraph containing an image
        if (t !== '') texts.push(t)
      })
      d = texts.join(' ')
      // grab img link from markdown
      const linkReg = /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_\+.~#?&//=]*)/
      imgs.forEach(img => {
        const linkMatch = img.match(linkReg)
        if (Array.isArray(linkMatch)) {
          const val = linkMatch[0]
          content.push({ key: 'img', val })
        }
      })
    }

    /*
    // email handling
    const emails = d.match(emailRegex())
    if(Array.isArray(emails)) {
      emails.forEach(e => d.replace(e, `<${e}>`))
    }
    */

    // iframe handling
    const iframeTagRe = /IFRAME\-START(.+?(?=IFRAME\-END))IFRAME\-END/
    const iframeTagMatch = iframeTagRe.exec(d)
    if (Array.isArray(iframeTagMatch)) {
      let iframeTexts = []
      d.split(iframeTagRe).forEach(t => {
        if (ytRegex().test(t)) {
          return content.push({ key: 'youtube', val: ytRegex().exec(t)[1] })
        }
        if (vmRegex().test(t)) {
          return content.push({ key: 'vimeo', val: vmRegex().exec(t)[4] })
        }
        if (t !== '') iframeTexts.push(t)
      })
      d = iframeTexts.join(' ')
    }

    // push text
    if (d.length > 0) {
      let val = d

      // TODO handle captions and centering

      if (val.length < 200)
        if (haveLinks) {
          try {
            val = handleRefLinks(d, newLinks)
          } catch (err) {
            console.error(err)
          }
        }
      content.push({ key, val })
    }
  })

  /*
  if (oldContent.id === 7) {
    //console.log('=original'.padEnd(20, '='))
    //console.log(p.content.rendered)
    //console.log('=markdown'.padEnd(20, '='))
    //console.log(markdown)
    console.log('=mds'.padEnd(20, '='))
    console.log(mds)
    //console.log('=lex'.padEnd(20, '='))
    //console.log(lex)
    console.log('=final'.padEnd(20, '='))
    console.log(result.content)
  }
  */

  return content
}
