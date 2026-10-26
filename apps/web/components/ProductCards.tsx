"use client";
/**
 * Search results as cards, for people who can see some or all of the screen.
 * The spoken reply already names each product, so the list is labelled and
 * every card has a heading: screen-reader users can skip it or jump through it.
 * Buttons send a plain request to the companion, so nothing here bypasses the
 * agent, the grounding check or the read-back.
 */
import type { ShownProduct } from "@open-aisle/core/agent";

export function ProductCards(props: { items: ShownProduct[]; disabled: boolean; onAsk: (text: string) => void }) {
  return (
    <ul className="products" aria-label={`${props.items.length} ${props.items.length === 1 ? "product" : "products"} found`}>
      {props.items.map((p) => {
        const sizes = p.options.size;
        return (
          <li key={p.productId} className="product">
            <div className="product__photo">{p.imageUrl ? <img src={p.imageUrl} alt={p.imageAlt} loading="lazy" /> : <span className="product__nophoto">No photo</span>}</div>
            <div className="product__body">
              <h4 className="product__title">{p.title}</h4>
              <p className="product__price">{p.price}</p>
              <p className="product__meta">
                {p.store}
                <br />
                Arrives {p.arrives}
              </p>
              {sizes && sizes.length > 0 && <p className="product__meta">Sizes {sizes.join(", ")}</p>}
              <div className="product__actions">
                <button type="button" className="btn btn--small" disabled={props.disabled} onClick={() => props.onAsk(`Tell me more about the ${p.title}`)}>
                  Details<span className="visually-hidden"> about {p.title}</span>
                </button>
                <button type="button" className="btn btn--small btn--primary" disabled={props.disabled} onClick={() => props.onAsk(`Add the ${p.title} to my cart`)}>
                  Add to cart<span className="visually-hidden">: {p.title}</span>
                </button>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
