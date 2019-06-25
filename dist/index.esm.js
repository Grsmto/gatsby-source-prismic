import _merge from 'lodash/fp/merge';
import _keys from 'lodash/fp/keys';
import _isFunction from 'lodash/fp/isFunction';
import _isPlainObject from 'lodash/fp/isPlainObject';
import _head from 'lodash/fp/head';
import _has from 'lodash/fp/has';
import _compose from 'lodash/fp/compose';
import _camelCase from 'lodash/fp/camelCase';
import { useState, useCallback, useEffect } from 'react';
import { set } from 'es-cookie';
import Prismic from 'prismic-javascript';
import uuidv5 from 'uuid/v5';
import md5 from 'md5';
import traverse from 'traverse';
import { compose, then, fromPairs, map, toPairs, cond, test, always, T, identity, prop, find, propEq, pick, omit, propOr } from 'ramda';
import { allP, mapIndexed } from 'ramda-adjunct';
import pascalcase from 'pascalcase';
import PrismicDOM from 'prismic-dom';

const IMAGE_FIELD_KEYS = ['dimensions', 'alt', 'copyright', 'url', 'localFile'];

const getTypeForPath = (path, typePaths) => compose(cond([[test(/^\[.*GroupType\]$/), always('Group')], [test(/^\[.*SlicesType\]$/), always('Slices')], [T, identity]]), prop('type'), find(propEq('path', path)))(typePaths);

const normalizeField = async (id, value, depth, context) => {
  const {
    doc,
    typePaths,
    createNode,
    createNodeId,
    createContentDigest,
    normalizeImageField,
    normalizeLinkField,
    normalizeSlicesField,
    normalizeStructuredTextField
  } = context;
  const type = getTypeForPath([...depth, id], typePaths);

  switch (type) {
    case 'PrismicImageType':
      const base = await compose(async baseValue => await normalizeImageField(id, baseValue, depth, context), pick(IMAGE_FIELD_KEYS))(value); // Thumbnail image data are siblings of the base image data so we need to
      // smartly extract and normalize the key-value pairs.

      const thumbs = await compose(then(fromPairs), allP, map(async ([k, v]) => [k, await normalizeImageField(id, v, depth, context)]), toPairs, omit(IMAGE_FIELD_KEYS))(value);
      return { ...base,
        ...thumbs
      };

    case 'PrismicStructuredTextType':
      return await normalizeStructuredTextField(id, value, depth, context);

    case 'PrismicLinkType':
      return await normalizeLinkField(id, value, depth, context);

    case 'Group':
      return await normalizeObjs(value, [...depth, id], context);

    case 'Slices':
      const sliceNodeIds = await compose(allP, mapIndexed(async (v, idx) => {
        const sliceNodeId = createNodeId(`${doc.type} ${doc.id} ${id} ${idx}`);
        const normalizedPrimary = await normalizeObj(propOr({}, 'primary', v), [...depth, id, v.slice_type, 'primary'], context);
        const normalizedItems = await normalizeObjs(propOr([], 'items', v), [...depth, id, v.slice_type, 'items'], context);
        createNode({ ...v,
          id: sliceNodeId,
          primary: normalizedPrimary,
          items: normalizedItems,
          internal: {
            type: pascalcase(`Prismic ${doc.type} ${id} ${v.slice_type}`),
            contentDigest: createContentDigest(v)
          }
        });
        return sliceNodeId;
      }))(value);
      return await normalizeSlicesField(id, sliceNodeIds, [...depth, id], context);

    default:
      return value;
  }
}; // Returns a promise that resolves after normalizing each property in an
// object.


const normalizeObj = (obj, depth, context) => compose(then(fromPairs), allP, map(async ([k, v]) => [k, await normalizeField(k, v, depth, context)]), toPairs)(obj); // Returns a promise that resolves after normalizing a list of objects.


const normalizeObjs = (objs, depth, context) => compose(allP, map(obj => normalizeObj(obj, depth, context)))(objs);

const documentToNodes = async (doc, context) => {
  const {
    createNodeId,
    createContentDigest,
    createNode
  } = context;
  const docNodeId = createNodeId(`${doc.type} ${doc.id}`);
  const normalizedData = await normalizeObj(doc.data, [doc.type, 'data'], { ...context,
    doc,
    docNodeId
  });
  createNode({ ...doc,
    id: docNodeId,
    prismicId: doc.id,
    data: normalizedData,
    dataString: JSON.stringify(doc.data),
    dataRaw: doc.data,
    internal: {
      type: pascalcase(`Prismic ${doc.type}`),
      contentDigest: createContentDigest(doc)
    }
  });
  return docNodeId;
};

// versions of the value using `prismic-dom` on the `html` and `text` keys,
// respectively. The raw value is provided on the `raw` key.

const normalizeStructuredTextField = async (id, value, _depth, context) => {
  const {
    doc,
    pluginOptions
  } = context;
  const {
    linkResolver,
    htmlSerializer
  } = pluginOptions;
  const linkResolverForField = linkResolver({
    key: id,
    value,
    node: doc
  });
  const htmlSerializerForField = htmlSerializer({
    key: id,
    value,
    node: doc
  });
  return {
    html: PrismicDOM.RichText.asHtml(value, linkResolverForField, htmlSerializerForField),
    text: PrismicDOM.RichText.asText(value),
    raw: value
  };
};

const fetchAndCreateDocumentNodes = async (value, context) => {
  const {
    createNode,
    createNodeId,
    hasNodeById,
    pluginOptions
  } = context;
  const {
    repositoryName,
    accessToken,
    fetchLinks
  } = pluginOptions;
  const linkedDocId = createNodeId(`${value.type} ${value.id}`);
  if (hasNodeById(linkedDocId)) return; // Create a key in our cache to prevent infinite recursion.

  createNode({
    id: linkedDocId
  }); // Query Prismic's API for the actual document node.

  const apiEndpoint = `https://${repositoryName}.cdn.prismic.io/api/v2`;
  const api = await Prismic.api(apiEndpoint, {
    accessToken
  });
  const doc = await api.getByID(value.id, {
    fetchLinks
  }); // Normalize the document.

  await documentToNodes(doc, context);
};

const normalizeLinkField = async (id, value, _depth, context) => {
  const {
    doc,
    getNodeById,
    createNodeId,
    pluginOptions
  } = context;
  const {
    linkResolver
  } = pluginOptions;
  const linkResolverForField = linkResolver({
    key: id,
    value,
    node: doc
  });
  const linkedDocId = createNodeId(`${value.type} ${value.id}`); // Fetches, normalizes, and caches linked document if not present in cache.

  if (value.link_type === 'Document' && value.id) await fetchAndCreateDocumentNodes(value, context);
  const proxyHandler = {
    get: (obj, prop) => {
      if (prop === 'document') {
        if (value.link_type === 'Document') return getNodeById(linkedDocId);
        return null;
      }

      return obj[prop];
    }
  };
  return new Proxy({ ...value,
    url: PrismicDOM.Link.url(value, linkResolverForField),
    raw: value,
    document: null // TODO: ???????

  }, proxyHandler);
};
const normalizeSlicesField = async (_id, value, _depth, context) => {
  const {
    hasNodeById,
    getNodeById
  } = context;
  return new Proxy(value, {
    get: (obj, prop) => {
      if (hasNodeById(obj[prop])) {
        const node = getNodeById(obj[prop]);
        return { ...node,
          __typename: node.internal.type
        };
      }

      return obj[prop];
    }
  });
};
const normalizeImageField = async (_id, value) => ({ ...value,
  localFile: null
});

const seedConstant = `638f7a53-c567-4eca-8fc1-b23efb1cfb2b`;

const createNodeId = id => uuidv5(id, uuidv5('gatsby-source-prismic', seedConstant));

const createContentDigest = obj => md5(JSON.stringify(obj));

const isBrowser = typeof window !== 'undefined'; // Returns an object containing normalized Prismic preview data directly from
// the Prismic API. The normalized data object's shape is identical to the shape
// created by Gatsby at build time minus image processing due to running in the
// browser. Instead, image nodes return their source URL.

const usePrismicPreview = (location, overrides) => {
  if (!location) throw new Error('Invalid location object!. Please provide the location object from @reach/router.');
  if (!overrides.linkResolver || !_isFunction(overrides.linkResolver)) throw new Error('Invalid linkResolver! Please provide a function.');
  if (overrides.pathResolver && !_isFunction(overrides.pathResolver)) throw new Error('pathResolver is not a function! Please provide a function.');
  if (!overrides.htmlSerializer || !_isFunction(overrides.htmlSerializer)) throw new Error('Invalid htmlSerializer! Please provide a function.');
  const [state, setState] = useState({
    previewData: null,
    path: null,
    isInvalid: false
  });
  const {
    pluginOptions: rawPluginOptions,
    schemasDigest
  } = isBrowser ? window.___PRISMIC___ : {
    pluginOptions: {},
    schemasDigest: ''
  };
  const pluginOptions = { ...rawPluginOptions,
    ...overrides
  };
  const {
    fetchLinks,
    accessToken,
    repositoryName,
    pathResolver,
    linkResolver,
    typePathsFilenamePrefix
  } = pluginOptions;
  const apiEndpoint = `https://${repositoryName}.cdn.prismic.io/api/v2`; // Fetches raw preview data directly from Prismic via ID.

  const fetchRawPreviewData = useCallback(async id => {
    const api = await Prismic.getApi(apiEndpoint, {
      accessToken
    });
    return await api.getByID(id, {
      fetchLinks
    });
  }, [accessToken, apiEndpoint, fetchLinks]); // Fetches and parses the JSON file of the typePaths we write at build time.

  const fetchTypePaths = useCallback(async () => {
    const req = await fetch(`/${typePathsFilenamePrefix}${schemasDigest}.json`, {
      headers: {
        'Content-Type': 'application/json'
      }
    });
    return await req.json();
  }, [typePathsFilenamePrefix, schemasDigest]); // Normalizes preview data using browser-compatible normalize functions.

  const normalizePreviewData = useCallback(async rawPreviewData => {
    const typePaths = await fetchTypePaths();
    const nodeStore = new Map();

    const createNode = node => nodeStore.set(node.id, node);

    const hasNodeById = id => nodeStore.has(id);

    const getNodeById = id => nodeStore.get(id);

    const rootNodeId = await documentToNodes(rawPreviewData, {
      typePaths,
      createNode,
      createNodeId,
      createContentDigest,
      hasNodeById,
      getNodeById,
      pluginOptions,
      normalizeImageField,
      normalizeLinkField,
      normalizeSlicesField,
      normalizeStructuredTextField
    });
    const rootNode = nodeStore.get(rootNodeId);

    const prefixedType = _camelCase(rootNode.internal.type);

    return {
      [prefixedType]: rootNode
    };
  }, [fetchTypePaths, pluginOptions]); // Fetches and normalizes preview data from Prismic.

  const asyncEffect = useCallback(async () => {
    const searchParams = new URLSearchParams(location.search);
    const token = searchParams.get('token');
    const docID = searchParams.get('documentId'); // Required to send preview cookie on all API requests on future routes.

    set(Prismic.previewCookie, token);
    const rawPreviewData = await fetchRawPreviewData(docID);
    const path = pathResolver ? pathResolver(rawPreviewData) : linkResolver(rawPreviewData);
    const previewData = await normalizePreviewData(rawPreviewData);
    setState({ ...state,
      path,
      previewData
    });
  }, [fetchRawPreviewData, linkResolver, location.search, normalizePreviewData, pathResolver, state]);
  useEffect(() => {
    asyncEffect();
  }, []);
  return state;
}; // @private
// Returns a new object containing the traversally merged key-value
// pairs from previewData and staticData.
//
// We determine when to merge by comparingthe document id from previewData
// and replacing staticData's corresponding data object with
// the one from previewData.

const _traversalMerge = (staticData, previewData, key) => {
  const {
    data: previewDocData,
    id: previewId
  } = previewData[key];

  function handleNode(node) {
    if (_isPlainObject(node) && _has('id', node) && node.id === previewId) {
      this.update(_merge(node, {
        data: previewDocData
      }));
    }
  }

  return traverse(staticData).map(handleNode);
}; // @private
// Returns an object containing the merged contents of staticData
// and previewData based on the provided key.
//
// If the objects share the same top level key, perform a recursive
// merge. If the objects do not share the same top level key,
// traversally merge them.


const _mergeStaticData = (staticData, previewData) => {
  const previewKey = _compose(_head, _keys)(previewData);

  if (!_has(previewKey, staticData)) return _traversalMerge(staticData, previewData, previewKey);
  return _merge(staticData, previewData);
}; // Helper function that merges Gatsby's static data with normalized preview data.
// If the custom types are the same, deep merge with static data.
// If the custom types are different, deeply replace any document in the static
// data that matches the preview document's ID.


const mergePrismicPreviewData = ({
  staticData,
  previewData
}) => {
  if (!staticData && !previewData) throw new Error('Invalid data! Please provide at least staticData or previewData.');
  if (!staticData) return previewData;
  if (!previewData) return staticData;
  return _mergeStaticData(staticData, previewData);
};

export { mergePrismicPreviewData, usePrismicPreview };
