import fs from 'fs'
import path from 'path'
import { compose, values, mapObjIndexed, flatten, map, prop } from 'ramda'
import { allP } from 'ramda-adjunct'
import md5 from 'md5'

import { validatePluginOptions } from './validatePluginOptions'
import { fetchAllDocuments } from './fetchAllDocuments'
import {
  generateTypeDefsForCustomType,
  generateTypeDefForLinkType,
} from './generateTypeDefsForCustomType'
import { documentToNodes } from './documentToNodes'
import {
  normalizeImageField,
  normalizeLinkField,
  normalizeSlicesField,
  normalizeStructuredTextField,
} from './normalizers/node'
import standardTypes from './standardTypes.graphql'
import { name as pkgName } from '../package.json'

const msg = s => `${pkgName} - ${s}`

export const sourceNodes = async (gatsbyContext, rawPluginOptions) => {
  const { actions, reporter } = gatsbyContext
  const { createTypes } = actions

  const createTypesActivity = reporter.activityTimer(msg('create types'))
  const fetchDocumentsActivity = reporter.activityTimer(msg('fetch documents'))
  const createNodesActivity = reporter.activityTimer(msg('create nodes'))
  const writeTypePathsActivity = reporter.activityTimer(
    msg('write out type paths'),
  )

  /***
   * Validate plugin options. Set default options where necessary. If any
   * plugin options are invalid, stop immediately.
   */

  let pluginOptions

  try {
    pluginOptions = await validatePluginOptions(rawPluginOptions)
  } catch (error) {
    reporter.error(msg('invalid plugin options'))
    reporter.panic(msg(error.errors.join(', ')))
  }

  /***
   * Create types derived from Prismic custom type schemas.
   */

  createTypesActivity.start()
  reporter.verbose(msg('starting to create types'))

  const typeVals = compose(
    values,
    mapObjIndexed((json, id) =>
      generateTypeDefsForCustomType(id, json, {
        gatsbyContext,
        pluginOptions,
      }),
    ),
  )(pluginOptions.schemas)

  const typeDefs = compose(
    flatten,
    map(prop('typeDefs')),
  )(typeVals)

  const typePaths = compose(
    flatten,
    map(prop('typePaths')),
  )(typeVals)

  const linkTypeDef = generateTypeDefForLinkType(typeDefs, { gatsbyContext })

  createTypes(standardTypes)
  createTypes(linkTypeDef)
  createTypes(typeDefs)

  createTypesActivity.end()

  /***
   * Fetch documents from Prismic.
   */

  fetchDocumentsActivity.start()
  reporter.verbose(msg('starting to fetch documents'))

  const documents = await fetchAllDocuments(gatsbyContext, pluginOptions)

  reporter.verbose(msg(`fetched ${documents.length} documents`))
  fetchDocumentsActivity.end()

  /***
   * Create nodes for all documents
   */

  createNodesActivity.start()
  reporter.verbose(msg('starting to create nodes'))

  await compose(
    allP,
    map(doc =>
      documentToNodes(doc, {
        createNode: node => {
          reporter.verbose(
            msg(
              `creating node { id: "${node.id}", type: "${
                node.internal.type
              }" } `,
            ),
          )
          gatsbyContext.actions.createNode(node)
        },
        createNodeId: gatsbyContext.createNodeId,
        createContentDigest: gatsbyContext.createContentDigest,
        normalizeImageField,
        normalizeLinkField,
        normalizeSlicesField,
        normalizeStructuredTextField,
        typePaths,
        gatsbyContext,
        pluginOptions,
      }),
    ),
  )(documents)

  createNodesActivity.end()

  /***
   * Write type paths to public for use in Prismic previews.
   */

  writeTypePathsActivity.start()
  reporter.verbose(msg('starting to write out type paths'))

  const schemasDigest = md5(JSON.stringify(pluginOptions.schemas))
  const typePathsFilename = path.resolve(
    'public',
    pluginOptions.typePathsFilenamePrefix + schemasDigest + '.json',
  )

  reporter.verbose(msg(`writing out type paths to: ${typePathsFilename}`))
  fs.writeFileSync(typePathsFilename, JSON.stringify(typePaths))

  writeTypePathsActivity.end()
}
